/// <reference types="@cloudflare/workers-types" />

/**
 * Link an EXISTING product to a GitHub repository (EXPERIENCE.md §0.4 S1, AS 1.5): Settings →
 * Repository → **Link repository…**. The other link path, `linkRepo.ts`, creates a product from a
 * repository; this one hands a product that already exists (one created from nothing, or before
 * its repository had a `.pkey/`) over to its manifest.
 *
 * Two steps, so the operator sees what moves before anything is written:
 *
 *   1. `prepareLink` (the console's "Check"): the same checks `linkRepo` runs (the URL, the App
 *      installation, the manifest's parse) plus the ones only an existing product has (the
 *      manifest's slug is this product's, the product is not linked already) and every refusal
 *      resync would hit AFTER its first write (an issuer change outside the allowlist, an unsafe
 *      binary name, a catalog the validator refuses, a tier or profile licences still use). It
 *      writes nothing and answers the plan: what the manifest will apply, what stays because an
 *      operator set it in the console, what it deletes, and what blocks the link.
 *   2. `linkExistingProduct` (the console's "Link repository"): the same checks again, against
 *      the manifest as GitHub serves it now. The operator's check is pinned by `manifestDigest`:
 *      a push between the two steps refuses the link ("check again") instead of applying a
 *      manifest nobody looked at. Then the coordinates are written and `resyncRepo` applies the
 *      manifest, so a linked product's first apply and every later push run the same code.
 *
 * The plan (`planRepoManifest`) has the shape S-18 §4.5 gives ST-17's resync dry run
 * (`apply`, `skipClaimed`, `delete`, `conflicts`) and reads the same ownership columns
 * `applyRepoManifest` honours, so it says what that function will do. The console's Resync
 * confirm renders it through `planResync` (`POST …/release/resync?dryRun=1`, UX-78). ST-17 makes
 * resync, the webhook and the deploy hook record it too.
 */

import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import {} from "../../platform/json.js";
import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {} from "../../core/configDelivery.js";
import { type BreakGlassClaim } from "../../core/settingsClaims.js";
import { getProduct } from "../../core/products/store.js";
import {} from "../../core/manifestSnapshot.js";
import {} from "../../core/rowSettings.js";
import {} from "../../core/services.js";
import { displayNameOptions } from "../../core/accounts/reservedDisplayNames.js";
import { reservedNamesMode } from "../../core/licensing/reservedNames.js";
import {} from "../../core/publisher.js";
import { getReleaseConfig } from "./config.js";
import { parseManifest, type ParsedManifest } from "@polaris-key/manifest";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { digestManifestFiles, parseRepoUrl } from "./linkRepo.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import { readLinkedManifest, resyncRepo, type ResyncResult } from "./resync.js";
import type { Ingest } from "../../core/ingest/types.js";
import { stmtInsertReleaseConfig } from "./ingest.js";
import { getRepoIdentity } from "./github.js";

/** Which check a refusal belongs to: the console marks the rows before it passed. */
export type LinkCheck =
  | "product"
  | "repository"
  | "app"
  | "manifest"
  | "slug"
  | "policy";

/** One line of the plan. `id` names the row (a tier, a catalog key) when there is one. */
export type { ManifestPlan, PlanItem } from "../../core/ingest/types.js";
import type { ManifestPlan, PlanItem } from "../../core/ingest/types.js";

export type LinkRefusal = {
  ok: false;
  /** 409 when the manifest moved since the check; 422 for every other refusal. */
  status: 409 | 422;
  /** The coordinates had been written when the apply refused (or threw) and were put back. */
  afterWrite?: true;
  check: LinkCheck;
  error: string;
  errors?: string[];
};

export type PreparedLink =
  | {
      ok: true;
      /** `owner/repo`, as parsed from what the operator typed. */
      repository: string;
      owner: string;
      repo: string;
      installId: number;
      /** The default-branch commit the files were read at. */
      commit: string;
      /** sha-256 over the `.pkey/` files read: what the operator checked. A push that leaves
       *  `.pkey/` alone moves the commit but not the digest, so it does not refuse the link. */
      manifestDigest: string;
      manifest: ParsedManifest;
      plan: ManifestPlan;
      /** Secret NAMES the manifest references that the product does not hold yet. */
      remainingSecrets: string[];
    }
  | LinkRefusal;

export type LinkExistingResult =
  | {
      ok: true;
      repository: string;
      plan: ManifestPlan;
      updated: string[];
      refused?: Extract<ResyncResult, { ok: true }>["refused"];
      packSets?: Extract<ResyncResult, { ok: true }>["packSets"];
      feedProvisionSkipped?: Extract<
        ResyncResult,
        { ok: true }
      >["feedProvisionSkipped"];
      remainingSecrets: string[];
    }
  | LinkRefusal;

const refuse = (
  check: LinkCheck,
  error: string,
  errors?: string[],
): LinkRefusal => ({
  ok: false,
  status: 422,
  check,
  error,
  ...(errors ? { errors } : {}),
});

/**
 * Check that `repoUrl`'s `.pkey/` can take over `slug`, and plan what it would change. Writes
 * nothing. Every refusal names the check it failed.
 */
export async function prepareLink(
  env: Env,
  db: Db,
  slug: string,
  repoUrl: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
): Promise<PreparedLink> {
  const product = await getProduct(db, slug);
  if (!product) return refuse("product", "unknown product");
  // The system product is linked by the deploy hook from the platform repository, never here.
  if (product.system === 1 || slug === SYSTEM_PRODUCT_SLUG)
    return refuse(
      "product",
      `${slug} is the platform's own product: the deploy hook links it to the platform repository`,
    );
  if (product.release_source === "github") {
    const cfg = await getReleaseConfig(db, slug);
    const where =
      cfg?.gh_owner && cfg.gh_repo ? ` to ${cfg.gh_owner}/${cfg.gh_repo}` : "";
    return refuse(
      "product",
      `${slug} is already linked${where}; resync it instead`,
    );
  }

  const parsed = parseRepoUrl(repoUrl);
  if (!parsed)
    return refuse(
      "repository",
      "could not parse a github owner/repo from the URL",
    );
  const { owner, repo } = parsed;

  let installId: number;
  let token: string;
  try {
    installId = await discoverInstallation(env, owner, repo, now, fetchImpl);
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch (err) {
    return refuse(
      "app",
      err instanceof Error ? err.message : "github access failed",
    );
  }

  // Read exactly as link and resync do: every document at the default branch's head, one commit
  // (ST-01a, `manifestFetch.ts`).
  let files: Record<string, string>;
  let commit: string;
  try {
    ({ files, sha: commit } = await fetchPinnedManifestFiles(
      token,
      owner,
      repo,
      fetchImpl,
    ));
  } catch (err) {
    return refuse(
      "manifest",
      err instanceof Error ? err.message : "github manifest fetch failed",
    );
  }
  // The same reserved-name severity link, resync and the deploy hook parse with (LX-05).
  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    ...(await displayNameOptions(env, db, slug)),
  });
  if (!result.ok)
    return refuse("manifest", "manifest validation failed", result.errors);
  const manifest = result.manifest;

  if (manifest.product.slug !== slug)
    return refuse(
      "slug",
      `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    );

  // The refusals the apply would answer with, asked up front and all of them (plans/P0-26.md D5):
  // a link either applies whole or not at all. The publisher lookup is the apply's own, after
  // the coordinates are written, so it is not asked here.
  const dry = await ingest.plan(
    env,
    db,
    {
      mode: "apply",
      product: slug,
      manifest,
      now,
      warnings: result.warnings,
      source: {
        origin: "resync",
        sha: commit,
        files,
        fetchImpl,
        repo: {
          owner,
          name: repo,
          installId,
          identity: () => getRepoIdentity(token, owner, repo, fetchImpl),
          hasFile: async () => false,
          blob: async () => "error",
        },
      },
      seed: { product },
    },
    { skip: ["publisher"] },
  );
  const policy = dry.problems;
  if (policy[0])
    return refuse(
      "policy",
      policy[0].message,
      policy.length > 1 ? policy.map((p) => p.message) : undefined,
    );

  const plan = dry.plan!;
  plan.apply.unshift({
    area: "source",
    summary: `Source becomes ${owner}/${repo}: pushes to its default branch re-apply .pkey/`,
  });

  const held = new Set(
    (
      await db.all<{ name: string }>(
        "SELECT name FROM product_secrets WHERE product = ?",
        slug,
      )
    ).map((r) => r.name),
  );
  const remainingSecrets = secretNames(manifest).filter((n) => !held.has(n));

  return {
    ok: true,
    repository: `${owner}/${repo}`,
    owner,
    repo,
    installId,
    commit,
    manifestDigest: await digestManifestFiles(files),
    manifest,
    plan,
    remainingSecrets,
  };
}

/**
 * Link `slug` to `repoUrl` and apply its manifest. `manifestDigest` is the check's: a manifest
 * that changed since refuses with 409. A refusal from the apply itself puts the product back
 * to manual (the checks above make that a race with a push, not an expected path).
 */
export async function linkExistingProduct(
  env: Env,
  db: Db,
  slug: string,
  repoUrl: string,
  manifestDigest: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
): Promise<LinkExistingResult> {
  const prepared = await prepareLink(
    env,
    db,
    slug,
    repoUrl,
    now,
    fetchImpl,
    ingest,
  );
  if (!prepared.ok) return prepared;
  if (prepared.manifestDigest !== manifestDigest)
    return {
      ok: false,
      status: 409,
      check: "manifest",
      error: "the repository's .pkey/ changed since the check; check again",
    };
  if (prepared.plan.conflicts.length > 0)
    return refuse(
      "policy",
      "the manifest conflicts with this product",
      prepared.plan.conflicts.map((c) => c.summary),
    );

  const { owner, repo, installId, manifest } = prepared;
  const previous = await getProduct(db, slug);
  const prevConfig = await getReleaseConfig(db, slug);
  const rel = manifest.release;
  const row = stmtInsertReleaseConfig({
    product: slug,
    ghOwner: owner,
    ghRepo: repo,
    ghInstallationId: installId,
    channelWorkflow: rel?.channelWorkflow || null,
    betaBranch: rel?.betaBranch || "main",
    binaryName: rel?.binaryName || repo,
    sparkleEd25519Pub: rel?.sparkleEd25519Pub || null,
    summaryMarker: rel?.summaryMarker || "pkey:summary",
    metadataAccess: rel?.access.metadata ?? "public",
    artifactsAccess: rel?.access.artifacts ?? "public",
    accessSource: "manifest",
  });
  // The coordinates only. Everything else in the row (and the rest of the product) is the
  // resync's to write, under the same ownership rules every later push follows; a row that
  // already exists keeps its operator-owned columns.
  await db.batch([
    {
      sql: `${row.sql}
            ON CONFLICT(product) DO UPDATE SET
              gh_owner = excluded.gh_owner,
              gh_repo = excluded.gh_repo,
              gh_installation_id = excluded.gh_installation_id`,
      params: row.params,
    },
    {
      sql: `UPDATE products SET release_source = 'github', modified_at = ? WHERE slug = ?`,
      params: [now, slug],
    },
  ]);

  // Put the product back to manual: the source and the coordinates as they were. What a refused
  // resync already wrote stays, as for any resync (the checks above leave only a push racing
  // the apply able to get that far).
  const rollback = () =>
    db.batch([
      {
        sql: "UPDATE products SET release_source = ? WHERE slug = ?",
        params: [previous?.release_source ?? null, slug],
      },
      prevConfig
        ? {
            sql: "UPDATE release_config SET gh_owner = ?, gh_repo = ?, gh_installation_id = ? WHERE product = ?",
            params: [
              prevConfig.gh_owner,
              prevConfig.gh_repo,
              prevConfig.gh_installation_id,
              slug,
            ],
          }
        : {
            sql: "DELETE FROM release_config WHERE product = ?",
            params: [slug],
          },
    ]);

  let applied: ResyncResult;
  try {
    applied = await resyncRepo(env, db, slug, now, fetchImpl, ingest);
  } catch (err) {
    await rollback();
    throw err;
  }
  if (!applied.ok) {
    await rollback();
    return {
      ...refuse("policy", applied.error, applied.errors),
      afterWrite: true,
    };
  }
  return {
    ok: true,
    repository: prepared.repository,
    plan: prepared.plan,
    updated: applied.updated,
    ...(applied.refused ? { refused: applied.refused } : {}),
    ...(applied.packSets ? { packSets: applied.packSets } : {}),
    ...(applied.feedProvisionSkipped
      ? { feedProvisionSkipped: applied.feedProvisionSkipped }
      : {}),
    remainingSecrets: prepared.remainingSecrets,
  };
}

/** The resync dry run's answer (`POST …/release/resync?dryRun=1`, UX-78, S-18 §4.5 item 4). */
export type PlannedResync =
  | {
      ok: true;
      /** `owner/repo`, from the product's stored coordinates. */
      repository: string;
      /** The default-branch commit the files were read at. */
      commit: string;
      plan: ManifestPlan;
      /** ST-20: the break-glass claims the resync would keep (each one's field is skipped). */
      breakGlass: BreakGlassClaim[];
    }
  | LinkRefusal;

/**
 * What a resync of `slug` would do now: the manifest read by `readLinkedManifest`, the same read
 * `resyncRepo` makes (one pinned commit of the default branch), its pre-write refusals, and `planRepoManifest`'s plan.
 * Writes nothing: no sync state, no audit row, no snapshot. A refusal that the resync itself
 * would answer with (the product not linked, GitHub unreachable, the manifest invalid or not
 * this product's) refuses here too, naming the check; a policy refusal or a dropped row still in
 * use is a `conflicts` item, since that is what blocks the resync.
 */
export async function planResync(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
): Promise<PlannedResync> {
  const read = await readLinkedManifest(env, db, slug, now, fetchImpl);
  if (!read.ok) return refuse(read.check, read.error, read.errors);
  const { owner, repo, token, commit, manifest } = read;

  // Every refusal the resync would answer with, and the plan: the policy ones and a publisher
  // lookup GitHub cannot answer are `conflicts`, since that is what blocks the resync.
  const dry = await ingest.plan(env, db, {
    mode: "apply",
    product: slug,
    manifest,
    now,
    warnings: read.warnings,
    source: {
      origin: "resync",
      sha: commit,
      files: read.files,
      fetchImpl,
      repo: {
        owner,
        name: repo,
        installId: read.cfg.gh_installation_id ?? null,
        identity: () => getRepoIdentity(token, owner, repo, fetchImpl),
        hasFile: async () => false,
        blob: async () => "error",
      },
    },
    seed: { product: read.product, releaseConfig: read.cfg },
  });
  const plan = dry.plan!;
  plan.conflicts.unshift(
    ...dry.problems.map(
      (p): PlanItem => ({
        area: (p.area ?? "release") as PlanItem["area"],
        ...(p.id ? { id: p.id } : {}),
        summary: p.message,
      }),
    ),
  );
  return {
    ok: true,
    repository: `${owner}/${repo}`,
    commit,
    plan,
    breakGlass: dry.breakGlass,
  };
}

/** The distinct secret NAMES a manifest references (OIDC, edge-mint, provisioning hooks). */
function secretNames(manifest: ParsedManifest): string[] {
  const names = new Set<string>();
  if (manifest.oidc?.provider === "custom" && manifest.oidc.clientSecretSecret)
    names.add(manifest.oidc.clientSecretSecret);
  for (const e of manifest.edgeMint)
    if (e.signingKeySecret) names.add(e.signingKeySecret);
  for (const h of manifest.provisioning)
    if (h.secretKey) names.add(h.secretKey);
  return [...names];
}

/** The dry run's plan, as the pipeline computes it (`core/ingest/plan.ts`). */
export { planManifest as planRepoManifest } from "../../core/ingest/plan.js";
