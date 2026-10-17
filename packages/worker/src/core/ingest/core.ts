/**
 * Core's contribution to the manifest ingest (P0-26): the product row's manifest columns with
 * their audit rows, the create path's `products` / `product_keys` rows and ST-42's defaults, the
 * trusted publisher, the break-glass ends, and (after the batch) the service transitions and the
 * hosted-asset pulls. Moved from `services/release/{linkRepo,resync,systemProduct}.ts`.
 */

import { generateEd25519, seal } from "../../platform/keyvault.js";
import { SYSTEM_ACTORS, auditStatement } from "../audit.js";
import type { DbStatement } from "../../db/types.js";
import {
  CLAIMED_SQL,
  claimGuardParams,
  endBreakGlassStatements,
  type ClaimKey,
} from "../settingsClaims.js";
import {
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtSetAutoIssuePolicy,
  stmtSetFingerprintPolicy,
  stmtSetServices,
} from "../products/store.js";
import { planCreateDefaults } from "../products/createDefaults.js";
import { parseServices, serializeServices } from "../services.js";
import { serializeWebOrigins, parseWebOrigins } from "../cors.js";
import { parseStoredPresentation, serializePresentation } from "../products.js";
import {
  getPublisherPolicy,
  manifestPublisherChanged,
  stmtDeleteManifestPublisher,
  stmtUpsertManifestPublisher,
} from "../publisher.js";
import {
  applyServiceTransitions,
  MANIFEST_RESYNC_ACTOR,
} from "../servicesTransitions.js";
import { syncHostedAssets } from "../assets/hostedAssetPulls.js";
import { getProduct } from "../products/store.js";
import { parseJsonColumn } from "../../platform/json.js";
import { RELEASE_WORKFLOW_PATH } from "./constants.js";
import { manifestOwned, settingAuditor } from "./shared.js";
import type {
  IngestCheck,
  IngestContext,
  IngestProblem,
  ManifestContribution,
  ManifestContributor,
  RepoIdentity,
} from "./types.js";

interface PublisherChoice {
  repositoryId: number;
  repositoryOwnerId: number;
  repository: string;
  workflow: string;
  environment: string;
}

interface PublisherResolution {
  ok: true;
  current: Awaited<ReturnType<typeof getPublisherPolicy>>;
  claimed: boolean;
  next: PublisherChoice | null;
}

const lookupFailed = (err: unknown): string =>
  `could not resolve the repository's ids for publishing.trustedPublisher: ${err instanceof Error ? err.message : "github lookup failed"}`;

/** P2-02: the trusted-publisher policy the manifest asks for, resolved BEFORE the first write. */
function publisher(
  ctx: IngestContext,
): Promise<PublisherResolution | { ok: false; error: string }> {
  return ctx.read.memo("core.publisher", async () => {
    const declared = ctx.manifest.release?.trustedPublisher ?? null;
    // Create: no policy exists yet. Apply: an operator-claimed policy (`source = 'admin'`) is
    // never touched, no lookup and no write.
    const current =
      ctx.mode === "apply" ? await getPublisherPolicy(ctx.db, ctx.slug) : null;
    const claimed = current?.source === "admin";
    if (!declared || claimed) return { ok: true, current, claimed, next: null };
    // A declared publisher pins the repository's NUMERIC ids, resolved from GitHub, never taken
    // from the manifest. Without a repository (documents only) there is nothing to pin: refused.
    const repo = ctx.source.repo;
    if (!repo)
      return {
        ok: false,
        error:
          "could not resolve the repository's ids for publishing.trustedPublisher: no repository to read them from",
      } as const;
    try {
      const identity = await repo.identity();
      return {
        ok: true,
        current,
        claimed,
        next: {
          repositoryId: identity.id,
          repositoryOwnerId: identity.ownerId,
          repository: identity.fullName,
          workflow: declared.workflow,
          environment: declared.environment,
        },
      } as const;
    } catch (err) {
      return { ok: false, error: lookupFailed(err) } as const;
    }
  });
}

/** F9: the repository's release workflow as the CI publisher, when it exists at the commit. */
function trustedWorkflow(ctx: IngestContext): Promise<
  | {
      ok: true;
      repo: {
        repositoryId: number;
        repositoryOwnerId: number;
        repository: string;
        workflow: string;
      } | null;
    }
  | { ok: false; problem: IngestProblem }
> {
  return ctx.read.memo("core.trust", async () => {
    const wants =
      ctx.create?.choices?.trustReleaseWorkflow &&
      !ctx.manifest.release?.trustedPublisher;
    if (!wants) return { ok: true, repo: null } as const;
    const repo = ctx.source.repo;
    const fail = (
      message: string,
      reason: string,
    ): never | { ok: false; problem: IngestProblem } => ({
      ok: false,
      problem: {
        check: "trust",
        message,
        extra: { reason, fields: ["trustReleaseWorkflow"] },
      },
    });
    if (!repo)
      return fail(
        "the release workflow cannot be trusted without a repository",
        "release_workflow_unreadable",
      ) as { ok: false; problem: IngestProblem };
    try {
      if (!(await repo.hasFile(RELEASE_WORKFLOW_PATH)))
        return fail(
          `${RELEASE_WORKFLOW_PATH} does not exist in the repository`,
          "release_workflow_missing",
        ) as { ok: false; problem: IngestProblem };
      const identity: RepoIdentity = await repo.identity();
      return {
        ok: true,
        repo: {
          repositoryId: identity.id,
          repositoryOwnerId: identity.ownerId,
          repository: identity.fullName,
          workflow: RELEASE_WORKFLOW_PATH,
        },
      } as const;
    } catch (err) {
      return fail(
        `could not trust the release workflow: ${err instanceof Error ? err.message : "github lookup failed"}`,
        "release_workflow_unreadable",
      ) as { ok: false; problem: IngestProblem };
    }
  });
}

function checks(ctx: IngestContext): IngestCheck[] {
  const out: IngestCheck[] = [
    {
      check: "publisher",
      run: async () => {
        const r = await publisher(ctx);
        return r.ok ? null : { check: "publisher", message: r.error };
      },
    },
  ];
  if (ctx.mode === "create")
    out.push(
      {
        check: "services",
        run: async () =>
          (ctx.shared as { servicesProblem?: IngestProblem | null })
            .servicesProblem ?? null,
      },
      {
        check: "starter",
        run: async () =>
          ctx.create?.choices?.starterTier === "free" &&
          !ctx.services.license.enabled
            ? {
                check: "starter",
                message: "the Free tier needs the License service",
                extra: {
                  reason: "starter_tier_requires_license",
                  fields: ["starterTier"],
                },
              }
            : null,
      },
      {
        check: "trust",
        run: async () => {
          const t = await trustedWorkflow(ctx);
          return t.ok ? null : t.problem;
        },
      },
    );
  return out;
}

async function prepare(ctx: IngestContext): Promise<ManifestContribution> {
  return ctx.mode === "create" ? prepareCreate(ctx) : prepareApply(ctx);
}

async function afterCommit(ctx: IngestContext) {
  if (ctx.mode === "apply") {
    // PX-W17: the consequences of the services set now STORED (the manifest's, or the operator's
    // when the row is admin-claimed and the batch's write was a no-op). Idempotent: an
    // Identity-off product's stragglers heal here on every resync.
    await applyServiceTransitions(
      ctx.env,
      ctx.db,
      ctx.slug,
      parseServices((await getProduct(ctx.db, ctx.slug))?.services_json)
        .services,
      MANIFEST_RESYNC_ACTOR,
      ctx.now,
    );
  }
  // HA-05 (notes/S-20 §6.4): the hosted-asset pulls this manifest owes, enqueued AFTER the batch
  // (a new slot's row references the product) and best-effort (`syncHostedAssets` never throws).
  const assets = await syncHostedAssets(ctx.env, ctx.db, {
    product: ctx.slug,
    manifest: ctx.manifest,
    commit: ctx.source.sha,
    ...(ctx.source.repo ? { repoBlob: ctx.source.repo.blob } : {}),
    now: ctx.now,
  });
  return {
    ...(assets.enqueued > 0 && ctx.mode === "apply"
      ? { updated: ["assets"] }
      : {}),
    ...(assets.warnings.length > 0 && ctx.mode === "apply"
      ? { warnings: assets.warnings }
      : {}),
  };
}

// ── create ───────────────────────────────────────────────────────────────────────────────

async function prepareCreate(
  ctx: IngestContext,
): Promise<ManifestContribution> {
  const { manifest, slug, now } = ctx;
  const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}`;
  // Mint + seal the per-product Ed25519 signing key under the platform KEK.
  const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
  const encPrivate = await seal(ctx.env, privatePkcs8Pem, {
    product: slug,
    kind: "signing-key",
    id: kid,
  });
  ctx.shared.signingPublicKeys.push(publicRawB64url);

  const pub = await publisher(ctx);
  if (!pub.ok) throw new Error(pub.error); // refused by the check; never reached
  const trust = await trustedWorkflow(ctx);
  const plan = ctx.create
    ? planCreateDefaults({
        product: slug,
        now,
        services: ctx.services,
        choices: ctx.create.choices ?? {
          services: null,
          intendedPlatforms: [],
          starterTier: null,
          trustReleaseWorkflow: false,
        },
        declaredProfiles: manifest.profiles.map((p) => p.id),
        declaredTiers: manifest.tiers.map((t) => t.id),
        manifestHasPublisher: pub.next !== null,
        publisher: trust.ok ? trust.repo : null,
        author: ctx.create.author ?? "",
      })
    : null;

  const statements: DbStatement[] = [
    stmtInsertProduct({
      slug,
      name: manifest.product.name,
      signing_kid: kid,
      signing_pub: publicRawB64url,
      compat_min: manifest.product.compatMin,
      compat_max: manifest.product.compatMax,
      default_max_offline_days: manifest.product.defaultMaxOfflineDays,
      default_device_limit: manifest.product.defaultDeviceLimit,
      admin_group: manifest.product.adminGroup,
      branding_json: null,
      release_source: "github",
      // Which Polaris Key services this product runs (the registration policy is derived from
      // it, ST-38). In the SAME atomic batch as the row itself: enablement decides which routes
      // a product has, so there must be no instant where a product row exists without it.
      services_json: serializeServices({ services: ctx.services }),
      services_source: ctx.servicesSource,
      // The compat window is manifest-owned until an operator sets it in `update/settings`.
      compat_source: "manifest",
      // The CORS allowlist (P0-05). Validated by the manifest parser; NULL when undeclared.
      web_origins_json: serializeWebOrigins(manifest.webOrigins),
      // `.pkey/product` `presentation` (HA-12): manifest-only, NULL when undeclared.
      presentation_json: serializePresentation(manifest.presentation),
      created_at: now,
      modified_at: now,
    }),
    stmtInsertProductKey({
      product: slug,
      kid,
      alg: "Ed25519",
      public_b64url: publicRawB64url,
      enc_private_json: encPrivate,
      status: "active",
      created_at: now,
      rotated_at: null,
      revoked_at: null,
    }),
  ];
  // The trusted-publisher policy (P2-02), manifest-owned from the start.
  if (pub.next)
    statements.push(
      stmtUpsertManifestPublisher({ product: slug, ...pub.next, now }),
    );

  // ST-42's defaults, then the two policies a freshly linked (manifest-owned) product takes
  // unconditionally: after everything above, as the link wrote them.
  const tail: DbStatement[] = [...(plan?.statements ?? [])];
  if (manifest.fingerprint)
    tail.push(
      stmtSetFingerprintPolicy(
        slug,
        JSON.stringify(manifest.fingerprint),
        "manifest",
        now,
      ),
    );
  if (manifest.autoIssue)
    tail.push(
      stmtSetAutoIssuePolicy(
        slug,
        JSON.stringify(manifest.autoIssue),
        "manifest",
        now,
      ),
    );
  const defaults = plan?.created ?? {
    services: (
      Object.keys(ctx.services) as (keyof typeof ctx.services)[]
    ).filter((x) => ctx.services[x].enabled),
    profile: null,
    tier: null,
    intendedPlatforms: [],
    trustedWorkflow: null,
  };
  return {
    statements,
    tail,
    audits: [],
    updated: [],
    facts: {
      created: {
        kid,
        publicKey: publicRawB64url,
        defaults,
        services: ctx.services,
      },
    },
    afterCommit: () => afterCommit(ctx),
  };
}

// ── apply ────────────────────────────────────────────────────────────────────────────────

async function prepareApply(ctx: IngestContext): Promise<ManifestContribution> {
  const { manifest, slug, now, db } = ctx;
  const product = ctx.before!;
  const appliedSha = ctx.source.sha;
  const applyClaims = await ctx.claims();
  const claims = applyClaims.claimed;
  const rows = await ctx.rows();
  const claimed: string[] = [...rows.claimed];
  const { audits, auditSetting } = settingAuditor(slug, now, appliedSha);
  const updated: string[] = [];

  // The ended break-glass claims go first, so every claim guard below already sees them gone.
  const stmts: DbStatement[] = await endBreakGlassStatements(
    db,
    slug,
    applyClaims.ended,
    { actor: SYSTEM_ACTORS.resync, sha: appliedSha, now },
  );

  // The product row's manifest fields (S-18 §4.5 item 1). A field the console has claimed
  // (`product_settings`, ST-01b) is skipped; `admin_group` is manifest-only and always follows
  // the manifest (owner decision 1). `web_origins_json` (P0-05) keeps `omitClears`: dropping
  // `web.origins` from `.pkey/product` clears it back to NULL (no origin allowed) rather than
  // freezing the old list, unless the console has claimed it. `presentation_json` (HA-12) is
  // manifest-only like `admin_group`, and dropping `presentation` clears it to NULL; its row names
  // its own audit key (the fifth member), so it is audited as `core.presentation`, never as the
  // `core.adminGroup` fallback the unkeyed rows share.
  const nextOrigins = serializeWebOrigins(manifest.webOrigins);
  const nextPresentation = serializePresentation(manifest.presentation);
  const productFields: [string, ClaimKey | null, unknown, unknown, string?][] =
    [
      ["name", "core.name", product.name, manifest.product.name],
      [
        "default_max_offline_days",
        "license.defaults.maxOfflineDays",
        product.default_max_offline_days,
        manifest.product.defaultMaxOfflineDays,
      ],
      [
        "default_device_limit",
        "license.defaults.deviceLimit",
        product.default_device_limit,
        manifest.product.defaultDeviceLimit,
      ],
      ["admin_group", null, product.admin_group, manifest.product.adminGroup],
      [
        "web_origins_json",
        "core.web.origins",
        product.web_origins_json ?? null,
        nextOrigins,
      ],
      [
        "presentation_json",
        null,
        product.presentation_json ?? null,
        nextPresentation,
        "core.presentation",
      ],
    ];
  const sets: string[] = [];
  const setParams: (string | number | null)[] = [];
  for (const [column, key, before, after, auditKey] of productFields) {
    if (key && claims.has(key)) {
      claimed.push(key);
      continue;
    }
    // `claims` was read before the GitHub round trips; a console save may have claimed the key
    // since. The guard is therefore in the statement itself (the column keeps its value while a
    // live claim exists), like `compat_source` below and the tiers' `source` guard.
    if (key) {
      sets.push(
        `${column} = CASE WHEN ${CLAIMED_SQL} THEN ${column} ELSE ? END`,
      );
      setParams.push(
        ...claimGuardParams(slug, key, now),
        after as string | number | null,
      );
    } else {
      sets.push(`${column} = ?`);
      setParams.push(after as string | number | null);
    }
    if (before !== after)
      auditSetting(
        auditKey ?? key ?? "core.adminGroup",
        column === "web_origins_json"
          ? parseWebOrigins(before as string | null)
          : column === "presentation_json"
            ? parseStoredPresentation(before)
            : before,
        column === "web_origins_json"
          ? [...manifest.webOrigins]
          : column === "presentation_json"
            ? parseStoredPresentation(after)
            : after,
        key,
      );
  }
  stmts.push({
    sql: `UPDATE products SET ${[...sets, "modified_at = ?"].join(", ")} WHERE slug = ?`,
    params: [...setParams, now, slug],
  });
  // The compatibility window is operator-claimable (P0-01, 0022_a): once an operator sets it in
  // `update/settings`, `compat_source = 'admin'` and this statement matches no row. The guard is
  // the UPDATE's own WHERE clause, not a read-then-write.
  stmts.push({
    sql: `UPDATE products SET compat_min = ?, compat_max = ?
            WHERE slug = ? AND COALESCE(compat_source, 'manifest') = 'manifest'`,
    params: [manifest.product.compatMin, manifest.product.compatMax, slug],
  });
  if (
    (product.compat_source ?? "manifest") === "manifest" &&
    (product.compat_min !== manifest.product.compatMin ||
      product.compat_max !== manifest.product.compatMax)
  )
    auditSetting(
      "release.compatWindow",
      { min: product.compat_min, max: product.compat_max },
      { min: manifest.product.compatMin, max: manifest.product.compatMax },
      null,
      manifestOwned(slug, "products", "slug", "compat_source"),
    );
  updated.push("product");

  // The fingerprint policy is manifest-owned only until an operator edits it live; after that
  // the statement's guard skips the write, so a push can't clobber their change.
  if (manifest.fingerprint) {
    const fingerprintJson = JSON.stringify(manifest.fingerprint);
    stmts.push(
      stmtSetFingerprintPolicy(slug, fingerprintJson, "manifest", now),
    );
    if (
      (product.fingerprint_policy_source ?? "manifest") === "manifest" &&
      (product.fingerprint_policy_json ?? null) !== fingerprintJson
    )
      auditSetting(
        "license.fingerprint",
        parseJsonColumn(product.fingerprint_policy_json),
        manifest.fingerprint,
        null,
        manifestOwned(slug, "products", "slug", "fingerprint_policy_source"),
      );
    updated.push("fingerprint");
  }

  // Same ownership rule for the auto-issue policy: manifest-owned until an operator claims it.
  if (manifest.autoIssue) {
    const autoIssueJson = JSON.stringify(manifest.autoIssue);
    stmts.push(stmtSetAutoIssuePolicy(slug, autoIssueJson, "manifest", now));
    if (
      (product.auto_issue_source ?? "manifest") === "manifest" &&
      (product.auto_issue_json ?? null) !== autoIssueJson
    )
      auditSetting(
        "license.autoIssue",
        parseJsonColumn(product.auto_issue_json),
        manifest.autoIssue,
        null,
        manifestOwned(slug, "products", "slug", "auto_issue_source"),
      );
    updated.push("autoIssue");
  }

  // Service enablement + the device-registration policy, under the same ownership rule once
  // more. Unconditional (unlike the two above) because `services` is always present on a parsed
  // manifest. The registration policy is derived from the set (ST-38), and the write drops any
  // retired `registration` key. The `services_source = 'admin'` guard lives inside the
  // statement, so a push cannot turn a service back on after an operator has turned it off live.
  const manifestServicesJson = serializeServices({
    services: manifest.services,
  });
  stmts.push(stmtSetServices(slug, manifestServicesJson, "manifest", now));
  // Compared as the canonical serialisation both sides go through, so a stored set written by an
  // older spelling of the same enablement is not a change.
  const storedServices = parseServices(product.services_json);
  if (
    (product.services_source ?? "manifest") === "manifest" &&
    serializeServices(storedServices) !== manifestServicesJson
  )
    auditSetting(
      "core.services",
      storedServices.services,
      manifest.services,
      null,
      manifestOwned(slug, "products", "slug", "services_source"),
    );
  updated.push("services");

  // The trusted-publisher policy (P2-02): manifest-owned rows follow the manifest, written when
  // declared and dropped when not, and a change is audited. A claimed row is left exactly as the
  // operator set it, whatever the manifest says.
  const pub = await publisher(ctx);
  if (!pub.ok) throw new Error(pub.error); // refused by the check; never reached
  if (!pub.claimed) {
    stmts.push(
      pub.next
        ? stmtUpsertManifestPublisher({ product: slug, ...pub.next, now })
        : stmtDeleteManifestPublisher(slug),
    );
    if (manifestPublisherChanged(pub.current, pub.next)) {
      updated.push("publisher");
      const repo = ctx.source.repo;
      stmts.push(
        publisherAudit(
          slug,
          now,
          `manifest:${repo?.owner ?? ""}/${repo?.name ?? ""}`,
          pub.next
            ? `Trusted publisher set from the manifest: ${pub.next.repository} ${pub.next.workflow} (environment ${pub.next.environment})`
            : "Trusted publisher removed: the manifest no longer declares publishing.trustedPublisher",
        ),
      );
    }
  }

  return {
    statements: stmts,
    audits,
    updated,
    claimed,
    conflicts: rows.conflicts,
    afterCommit: () => afterCommit(ctx),
  };
}

/** The audit row for a manifest-driven publisher change, in the resync's batch. */
function publisherAudit(
  product: string,
  now: number,
  actor: string,
  summary: string,
): DbStatement {
  return auditStatement({
    product,
    at: now,
    actor_sub: actor,
    actor_name: "Manifest resync",
    actor_email: null,
    action: "ci.publisher.manifest",
    target_kind: "ci_publisher",
    target_id: product,
    summary,
  });
}

export const coreContributor: ManifestContributor = { checks, prepare };
