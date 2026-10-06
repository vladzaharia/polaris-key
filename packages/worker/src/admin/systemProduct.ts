/**
 * The system product (F-03, plans/F-01.md §6.3): `polaris-key` (`SYSTEM_PRODUCT_SLUG`), the
 * platform's own product, which owns the platform packages (our SDKs and the CLI image) on the
 * package feeds.
 *
 * `ensureSystemProduct` is the only thing that creates its row: the platform action
 * `POST /manage/api/platform/feeds/bootstrap`, idempotent and audited. It runs the same creation
 * path as a manual create (an Ed25519 signing key generated and sealed under `PLATFORM_KEK`, the
 * empty catalog), marks the row `system = 1`, enables Release and Distribution, turns its
 * `packageFeeds` on and seeds one feed per ecosystem with the platform's namespaces (§6.7):
 * `@polaris-key` (npm), `polaris-key` (Swift scope), `im.plrs.key` (Maven), the PyPI name
 * `polaris-key` and the Godot publisher `polaris-key`; OCI repositories and Cargo crates sit under
 * the owner. Swift releases must be signed (owner decision 2026-10-04). A second run creates
 * nothing and leaves an
 * operator's later settings alone (a service or `packageFeeds` switched off stays off); it
 * fills in any missing feed row and queues a full render.
 *
 * `linkSystemProduct` is the other half (F-10 automation, owner decision 2026-10-04): it links the
 * system product to the monorepo that ships the platform's SDKs and applies that repository's
 * root `.pkey/` (its package deliverables and its trusted publisher), which `linkRepo` refuses
 * for the reserved slug and `resyncRepo` cannot reach (it needs `release_source = 'github'`, which
 * the bootstrap never set). Without it every package publish is refused as `invalid_descriptor`.
 * The deploy hook (`src/platformDeploy.ts`, `POST /webhooks/deploy`) runs both on every production
 * deploy; both are idempotent.
 *
 * This lives in the admin layer, beside the manual create it mirrors: it writes Core's product
 * rows and Distribution's feed rows in one batch, which Core itself may not (rule 6).
 */

import {
  SYSTEM_PRODUCT_SLUG,
  type ParsedManifest,
} from "@polaris-key/manifest";
import type { Env } from "../env.js";
import type { Db, DbStatement } from "../db/types.js";
import { generateEd25519, seal } from "../keyvault.js";
import {
  getProduct,
  stmtInsertProduct,
  stmtInsertProductKey,
  stmtInsertSchema,
} from "../repo.js";
import { parseServices, serializeServices } from "../core/services.js";
import type { ManifestIngest } from "../core/registry.js";
import {
  getPublisherPolicy,
  manifestPublisherChanged,
  stmtDeleteManifestPublisher,
  stmtUpsertManifestPublisher,
} from "../core/publisher.js";
import { stmtInsertReleaseConfig } from "../repo.js";
import { manifestDeliverableStatements } from "../services/release/deliverables.js";
import { manifestSnapshotStatement } from "../core/manifestSnapshot.js";
import {
  claimsForApply,
  endBreakGlassStatements,
  type AuditActor,
  type BreakGlassClaim,
  type ClaimKey,
} from "../core/settingsClaims.js";
import { isSafeBinaryName } from "../services/release/install.js";
import { stmtEnqueuePackageRender, RENDER_ALL } from "../core/registryQueue.js";
import {
  stmtEnsureFeed,
  stmtSetPackageFeeds,
} from "../services/distribution/registryFeeds.js";

/** The platform feeds' namespaces and extensions (plans/F-01.md §6.7, §5.3). */
export const SYSTEM_FEEDS = [
  { ecosystem: "npm", namespace: { scope: "@polaris-key" }, ext: {} },
  {
    ecosystem: "pypi",
    namespace: { names: ["polaris-key"], prefixes: [] },
    ext: { htmlFallback: true },
  },
  {
    ecosystem: "swift",
    namespace: { scope: "polaris-key" },
    ext: { requireSigned: true },
  },
  {
    ecosystem: "maven",
    namespace: { groupPrefixes: ["im.plrs.key"] },
    ext: {},
  },
  { ecosystem: "oci", namespace: {}, ext: {} },
  { ecosystem: "godot", namespace: { publisher: "polaris-key" }, ext: {} },
  // F-30: crates sit in the owner's own index (no namespace); empty until a Rust SDK ships.
  { ecosystem: "cargo", namespace: {}, ext: {} },
] as const;

export type EnsureSystemProduct =
  | { ok: true; created: boolean; slug: string }
  | { ok: false; reason: "slug_taken"; message: string };

export async function ensureSystemProduct(
  env: Env,
  db: Db,
  by: string,
  now: number,
): Promise<EnsureSystemProduct> {
  const slug = SYSTEM_PRODUCT_SLUG;
  const existing = await getProduct(db, slug);
  if (existing && existing.system !== 1)
    return {
      ok: false,
      reason: "slug_taken",
      message: `a product named ${slug} exists and is not the system product; it must be removed by hand before the bootstrap can run`,
    };
  const stmts: DbStatement[] = [];
  if (!existing) {
    const kid = `${slug}-${new Date(now * 1000).getUTCFullYear()}`;
    const { privatePkcs8Pem, publicRawB64url } = await generateEd25519();
    const encPrivate = await seal(env, privatePkcs8Pem, {
      product: slug,
      kind: "signing-key",
      id: kid,
    });
    stmts.push(
      stmtInsertProduct({
        slug,
        name: "Polaris Key",
        signing_kid: kid,
        signing_pub: publicRawB64url,
        compat_min: "0.0.0",
        compat_max: "99.0.0",
        default_max_offline_days: 30,
        default_device_limit: 5,
        admin_group: null,
        branding_json: null,
        release_source: null,
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
      stmtInsertSchema({
        product: slug,
        catalog_version: 1,
        catalog_json: JSON.stringify({ schemaVersion: 1, entries: [] }),
        active: 1,
        created_at: now,
      }),
    );
  }
  if (!existing) {
    // First run only: the services start on. A later run never turns back on what an operator
    // switched off.
    const services = parseServices(null);
    services.services.release = { enabled: true };
    services.services.distribution = { enabled: true };
    stmts.push({
      sql: `UPDATE products SET system = 1, services_json = ?, services_source = 'admin',
                                modified_at = ?
             WHERE slug = ?`,
      params: [serializeServices(services), now, slug],
    });
  }
  stmts.push(
    // `packageFeeds`: created ON if there is no row; an existing row (an operator's off) stays.
    stmtSetPackageFeeds(slug, true, 0, by, now),
    ...SYSTEM_FEEDS.map((f) =>
      stmtEnsureFeed(slug, f.ecosystem, f.namespace, f.ext, by, now),
    ),
    stmtEnqueuePackageRender(slug, RENDER_ALL, "package-feeds", now),
  );
  await db.batch(stmts);
  return { ok: true, created: !existing, slug };
}

/** The repository the system product is linked to: the platform's own monorepo. */
export interface SystemRepository {
  /** `owner/repo` as GitHub spells it. */
  repository: string;
  /** GitHub's NUMERIC ids, pinned against name recycling (as `ci_publishers` pins them). */
  repositoryId: number;
  repositoryOwnerId: number;
}

export type LinkSystemProduct =
  | {
      ok: true;
      slug: string;
      /** The package deliverable ids the manifest declares, now in `release_deliverables`. */
      packages: string[];
      /** What the manifest-owned trusted publisher now is (`null`: none declared). */
      publisher: { workflow: string; environment: string } | null;
      /** An operator claimed the publisher (`source = 'admin'`): it was left exactly as set. */
      publisherClaimed: boolean;
      /** Whether this run changed the manifest-owned publisher. */
      publisherChanged: boolean;
      /**
       * ST-20 (S-18 §4.5 item 7): the live break-glass claims after this apply. The deploy
       * summary lists them.
       */
      breakGlass: BreakGlassClaim[];
      /** ST-20: the break-glass claims this apply ended (expired, or the manifest changed them). */
      breakGlassEnded: { key: ClaimKey; why: "expired" | "changed" }[];
    }
  | {
      ok: false;
      reason: "not_bootstrapped" | "wrong_manifest";
      message: string;
    };

/**
 * Why `manifest` is not the system product's root `.pkey/` for `repo`, or `null` when it is: the
 * slug must be the system product's, and `.pkey/release` must exist and name `repo` as its GitHub
 * provider. Checked by the deploy hook before anything is written, and again by the link.
 */
export function systemManifestProblem(
  manifest: ParsedManifest,
  repo: Pick<SystemRepository, "repository">,
): string | null {
  const slug = SYSTEM_PRODUCT_SLUG;
  if (manifest.product.slug !== slug)
    return `the manifest is ${manifest.product.slug}'s, not the system product's (${slug})`;
  const rel = manifest.release;
  if (!rel) return "the manifest has no .pkey/release";
  const [owner, name] = repo.repository.split("/");
  if (
    !owner ||
    !name ||
    rel.ghOwner.toLowerCase() !== owner.toLowerCase() ||
    rel.ghRepo.toLowerCase() !== name.toLowerCase()
  )
    return `.pkey/release names ${rel.ghOwner}/${rel.ghRepo}, not the platform repository ${repo.repository}`;
  if (!isSafeBinaryName(rel.binaryName || name))
    return `unsafe binary name ${JSON.stringify(rel.binaryName || name)}`;
  return null;
}

/**
 * Link the system product to `repo` and apply its root `.pkey/` (already parsed and validated by
 * the caller). Idempotent, one batch:
 *
 *   - `release_source = 'github'` and `release_config`: the GitHub coordinates and the
 *     manifest-owned columns, the manual channels among them (an existing row keeps its
 *     installation id, the operator-only policy, the release keys and claimed access modes);
 *   - the declared deliverables (`manifestDeliverableStatements`, the same rows link and resync
 *     write; a package with releases is never dropped);
 *   - the manifest-owned trusted publisher, with the repository's numeric ids from `repo` (never
 *     from the manifest), and never over an operator's claim;
 *   - every ENABLED service's own manifest rows (`ingest`), by the product's STORED enablement, so
 *     a service an operator switched off is not rewritten;
 *   - the manifest snapshot (ST-01a, `product_manifest_snapshot`, origin `deploy-hook`): the raw
 *     documents the hook body carried and the deploy's commit (`PKEY_GIT_SHA`) as `applied_sha`.
 *
 *   - ST-20: the system product's break-glass claims (it is manifest-authoritative, locked; S-18
 *     §4.5 items 7–8). One whose 7 days ran out, or whose field this manifest changes from the
 *     last applied one, ends here and the manifest's value is written (`endBreakGlassStatements`);
 *     the rest stay, and the answer lists them for the deploy summary.
 *
 * Apart from ended break-glass claims it never touches the services, `packageFeeds`, the feeds,
 * the signing key or the catalog: those are the bootstrap's (and then the operator's). Applying
 * every claimable product field here is ST-17's shared plan function.
 */
export async function linkSystemProduct(
  db: Db,
  manifest: ParsedManifest,
  repo: SystemRepository,
  applied: {
    /** The raw `.pkey/` documents `manifest` was parsed from, keyed by document name. */
    files: Readonly<Record<string, string>>;
    /** The deploy's commit (`PKEY_GIT_SHA`); `null` (or malformed) is stored as NULL. */
    sha: string | null;
  },
  now: number,
  ingest?: ManifestIngest,
): Promise<LinkSystemProduct> {
  const slug = SYSTEM_PRODUCT_SLUG;
  const product = await getProduct(db, slug);
  if (!product || product.system !== 1)
    return {
      ok: false,
      reason: "not_bootstrapped",
      message: `${slug} is not the system product yet; run the package-feeds bootstrap first`,
    };
  const problem = systemManifestProblem(manifest, repo);
  if (problem) return { ok: false, reason: "wrong_manifest", message: problem };
  const rel = manifest.release!;
  const [owner, name] = repo.repository.split("/") as [string, string];
  const binaryName = rel.binaryName || name;

  const stmts: DbStatement[] = [
    {
      sql: `UPDATE products SET release_source = 'github', modified_at = ?
             WHERE slug = ? AND system = 1`,
      params: [now, slug],
    },
  ];
  const manualChannelsJson = rel.manualChannels.length
    ? JSON.stringify(rel.manualChannels)
    : null;
  const artifactPolicyJson = rel.artifactPolicy
    ? JSON.stringify(rel.artifactPolicy)
    : null;
  const ignoreTagsJson = rel.ignoreTags.length
    ? JSON.stringify(rel.ignoreTags)
    : null;
  const config = stmtInsertReleaseConfig({
    product: slug,
    ghOwner: owner,
    ghRepo: name,
    ghInstallationId: null,
    channelWorkflow: rel.channelWorkflow || null,
    betaBranch: rel.betaBranch || "main",
    binaryName,
    sparkleEd25519Pub: rel.sparkleEd25519Pub || null,
    summaryMarker: rel.summaryMarker || "pkey:summary",
    manualChannelsJson,
    artifactPolicyJson,
    metadataAccess: rel.access.metadata,
    artifactsAccess: rel.access.artifacts,
    accessSource: "manifest",
    stableTagPattern: rel.stableTagPattern,
    ignoreTagsJson,
  });
  // A first link inserts the row; a later one re-applies the manifest-owned columns exactly as a
  // resync does (`resync.ts`): the manual channels a package publish's `channel` is checked
  // against among them. The installation id, the operator-only policy, the release keys and the
  // access modes once an operator claimed them (`access_source = 'admin'`) are never touched.
  stmts.push({
    sql: `${config.sql}
          ON CONFLICT(product) DO UPDATE SET
            gh_owner = excluded.gh_owner,
            gh_repo = excluded.gh_repo,
            channel_workflow = excluded.channel_workflow,
            beta_branch = excluded.beta_branch,
            binary_name = excluded.binary_name,
            sparkle_ed25519_pub = excluded.sparkle_ed25519_pub,
            summary_marker = excluded.summary_marker,
            manual_channels_json = excluded.manual_channels_json,
            artifact_policy_json = excluded.artifact_policy_json,
            stable_tag_pattern = excluded.stable_tag_pattern,
            ignore_tags_json = excluded.ignore_tags_json,
            metadata_access = CASE WHEN COALESCE(release_config.access_source, 'manifest') = 'manifest'
                                   THEN excluded.metadata_access ELSE release_config.metadata_access END,
            artifacts_access = CASE WHEN COALESCE(release_config.access_source, 'manifest') = 'manifest'
                                    THEN excluded.artifacts_access ELSE release_config.artifacts_access END`,
    params: config.params,
  });
  stmts.push(
    ...manifestDeliverableStatements(
      slug,
      rel.app,
      now,
      rel.packDeliverables,
      rel.packageDeliverables,
    ),
  );

  const current = await getPublisherPolicy(db, slug);
  const claimed = current?.source === "admin";
  const declared = rel.trustedPublisher ?? null;
  const next = declared
    ? {
        repositoryId: repo.repositoryId,
        repositoryOwnerId: repo.repositoryOwnerId,
        repository: repo.repository,
        workflow: declared.workflow,
        environment: declared.environment,
      }
    : null;
  const publisherChanged = !claimed && manifestPublisherChanged(current, next);
  if (!claimed)
    stmts.push(
      next
        ? stmtUpsertManifestPublisher({ product: slug, ...next, now })
        : stmtDeleteManifestPublisher(slug),
    );

  if (ingest) {
    const services = parseServices(product.services_json).services;
    stmts.push(...ingest(manifest, slug, services, now).statements);
  }
  // ST-20: break-glass claims, compared against the snapshot this batch replaces (read first).
  const claims = await claimsForApply(db, slug, manifest, now);
  stmts.push(
    ...(await endBreakGlassStatements(db, slug, claims.ended, {
      actor: DEPLOY_ACTOR,
      sha: applied.sha,
      now,
      apply: manifest,
    })),
  );
  stmts.push(
    await manifestSnapshotStatement(
      slug,
      "deploy-hook",
      applied.sha,
      applied.files,
      manifest,
      now,
    ),
  );
  await db.batch(stmts);
  return {
    ok: true,
    slug,
    packages: rel.packageDeliverables.map((p) => p.id).sort(),
    publisher: declared
      ? { workflow: declared.workflow, environment: declared.environment }
      : null,
    publisherClaimed: claimed,
    publisherChanged,
    breakGlass: claims.live,
    breakGlassEnded: claims.ended.map((e) => ({ key: e.key, why: e.why })),
  };
}

/** The actor of the deploy hook's settings audit rows. */
export const DEPLOY_ACTOR: AuditActor = {
  sub: "deploy",
  name: "Deploy hook",
  email: null,
};
