/// <reference types="@cloudflare/workers-types" />

/**
 * Re-fetch a linked repo's manifest and re-apply it to an already-registered product. This is
 * the "resync" path: an operator pushes new manifest files and asks Polaris Key to pick up the
 * changes WITHOUT minting a new product or touching the signing key.
 *
 * Minimal-viable scope (diff-then-update): we re-parse the manifest and update the catalog
 * (new active schema version), the release block (channel/binary/marker/pub), and the OIDC +
 * tiers rows. The signing key, secrets, and edge-mint key material are NOT re-minted here, and
 * edge-mint APPROVALS are never written here (P0-12) — only orphaned ones are deleted.
 *
 * ST-01b (notes/S-18 §4.5, model C). Every check runs before the first write and every write goes
 * in ONE `db.batch`, so a refused resync writes nothing. A setting the console has claimed
 * (`product_settings`: the name, the licence defaults, the web origins, the catalog) is skipped;
 * tiers and profiles are applied per row, leaving `console` rows alone; and each setting or row
 * the batch changes gets its own `setting.resync` audit row.
 *
 * The apply also seals the secret values a manifest declares under catalog-declared secret keys,
 * and refuses (before the batch, like every other check) a push that would swap the stored Sparkle
 * key or overwrite an already-sealed profile secret: `sparkleKeyRefusal`, `manifestSecrets.ts`.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { systemResyncRefusal } from "../../core/settingsClaims.js";
import { type ProductRow } from "../../core/repo.js";
import { getProduct } from "../../core/products/store.js";
import { invalidateWidenedEdgeMintApprovals } from "../../core/edgeMintApproval.js";
import { getReleaseConfig, type ReleaseConfigRow } from "./config.js";
import { parseManifest, type ParsedManifest } from "@polaris-key/manifest";
import {
  discoverInstallation,
  type FetchImpl,
  getInstallationToken,
} from "./githubApp.js";
import { getRepoIdentity } from "./github.js";
import { fetchPinnedManifestFiles } from "./manifestFetch.js";
import type { StoreOutcome } from "./packs/sets.js";
import type { BreakGlassClaim, ClaimKey } from "../../core/settingsClaims.js";
import { reservedNamesMode } from "../../core/licensing/reservedNames.js";
import { reservedDisplayNamesMode } from "../../core/accounts/reservedDisplayNames.js";
import { type AssetWarning } from "../../core/assets/hostedAssetPulls.js";
import { repoBlobLookup } from "./assetSource.js";
import type { Ingest, PlanWarning } from "../../core/ingest/types.js";

export type ResyncResult =
  | {
      ok: true;
      updated: string[];
      /**
       * Parts of the manifest the sync refused while applying the rest (P3-03:
       * `release_key_is_product_key`, which keeps the previous `releaseKeys`). Absent when none.
       */
      refused?: { code: string; path: string; message: string }[];
      /**
       * P4-12: the pack-set re-resolution's outcome, when it failed (the sets were cleared;
       * the resync itself applied) or stored sets. Absent otherwise.
       */
      packSets?: StoreOutcome;
      /**
       * ST-01b: what the console has claimed and this resync therefore left alone — setting keys
       * (`core.name`, `config.catalog`, …) and console-owned rows (`tier:<id>`, `profile:<id>`).
       * Absent when none.
       */
      claimed?: string[];
      /**
       * ST-01b (S-18 §4.5 item 3): console rows holding the id of a row the manifest newly
       * declares. The console row is kept and the manifest's row is not applied. Absent when none.
       */
      conflicts?: { path: string; message: string }[];
      /**
       * HA-05: `asset_unreachable` for each declared asset whose source is failing (the last good
       * copy keeps serving). Warnings, never errors: a CDN outage never fails a resync. Absent
       * when none.
       */
      warnings?: AssetWarning[];
      /**
       * ST-20 (S-18 §4.5 item 7): the live break-glass claims after this resync (a
       * manifest-authoritative product's time-boxed console claims; each is also in `claimed`).
       * Every resync summary lists them. Absent when none.
       */
      breakGlass?: BreakGlassClaim[];
      /**
       * ST-20: the break-glass claims this resync ended, because their 7 days ran out or the
       * manifest changed the field; the manifest's value applied. Absent when none.
       */
      breakGlassEnded?: { key: ClaimKey; why: "expired" | "changed" }[];
      /**
       * F-34.2: the package ecosystems the manifest declares but whose feed was not provisioned,
       * each with the reason, so an operator sees why no feed appeared. Absent when none.
       */
      feedProvisionSkipped?: { ecosystem: string; reason: string }[];
    }
  | { ok: false; error: string; errors?: string[] };

/**
 * The `product_sync_state` notes for an applied resync: the parts it refused (P3-03) and the
 * console-row conflicts it kept (ST-01b), as stored JSON and as one readable line.
 */
export function resyncNotes(result: Extract<ResyncResult, { ok: true }>): {
  errors_json: string | null;
  message: string | null;
} {
  const lines = [
    ...(result.refused ?? []).map((r) => `${r.code}: ${r.message}`),
    ...(result.conflicts ?? []).map((c) => `conflict ${c.path}: ${c.message}`),
    // ST-20: every resync summary lists the live break-glass claims (not errors: no note row).
    ...(result.breakGlass ?? []).map(
      (b) =>
        `break-glass claim on ${b.key} until ${new Date(b.expiresAt * 1000).toISOString()}`,
    ),
  ];
  const notes = [
    ...(result.refused ?? []),
    ...(result.conflicts ?? []).map((c) => ({ conflict: true, ...c })),
  ];
  return {
    errors_json: notes.length > 0 ? JSON.stringify(notes) : null,
    message: lines.length > 0 ? lines.join("; ") : null,
  };
}

/**
 * Re-apply a linked repo's `.pkey/` to an existing product. Resolves the GitHub coordinates
 * from `release_config`; if the product was never linked (no gh coordinates) it's an error.
 *
 * SECURITY (R6-05). This deliberately takes NO ref. It used to accept `payload.after` from
 * the webhook body, which made the manifest applied to production a function of a value in
 * the request body — an unreviewed branch or an old commit — structurally defeating branch
 * protection and required review on `.pkey/`. The documents are read from the DB-configured
 * repo's own default branch, pinned to the ONE head commit GitHub resolves for it
 * (`fetchPinnedManifestFiles`, ST-01a), with nothing caller-supplied choosing the content.
 *
 * ST-01a. The apply's batch also writes the product's manifest snapshot
 * (`product_manifest_snapshot`, origin `resync`, `applied_sha` = that pinned commit).
 *
 * P0-12. Whatever the outcome, an edge-mint approval the product has WIDENED is deleted once the
 * manifest has been applied (`invalidateWidenedEdgeMintApprovals`). Since ST-01b the apply is one
 * batch, so a refused or throwing push writes none of `services_json`, `auto_issue_json` or
 * `oidc_config`; the sweep still runs in a `finally`, so a repo writer can never skip it by making
 * the ingest fail. A `finally` does not run when the
 * Worker is KILLED after those writes (CPU limit, a cancelled webhook), so this is not the
 * guarantee: every writer of an approval input sweeps BEFORE it writes — `applyRepoManifest`, and
 * the console's services and License-policy edits (`console/handlers/servicesAdmin.ts`,
 * `services/license/settingsAdapters.ts`) — so no revert can be the first thing to look.
 */
export async function resyncRepo(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
  ingest: Ingest,
): Promise<ResyncResult> {
  // ST-20 (S-18 §4.5 item 8): the system product has one writer, the deploy hook, which applies
  // the root `.pkey/` at the deployed commit. A webhook push or a console resync would apply the
  // default branch's head instead, so two deploys of one commit could differ: refused, before any
  // GitHub read or write.
  const system = await getProduct(db, slug);
  const refusal = system ? systemResyncRefusal(system) : null;
  if (refusal) return { ok: false, error: refusal };
  let result: ResyncResult;
  let dropped: string[];
  try {
    result = await applyRepoManifest(env, db, slug, now, fetchImpl, ingest);
  } finally {
    // Every manifest-owned input to an approval that this push wrote is written by now (all in
    // the apply's one batch: `services_json`, `auto_issue_json`, `oidc_config`).
    // An approval this push widened is dropped here, audited as `config.mint.invalidate`, and its
    // recipe is `pending` until an operator re-approves it — a later push, or a console edit, that
    // reverts the widening cannot restore it. Runs on the throw path too.
    dropped = await invalidateWidenedEdgeMintApprovals(
      db,
      slug,
      now,
      "widened by a manifest push",
    );
  }
  if (
    result.ok &&
    dropped.length > 0 &&
    !result.updated.includes("edgeMintApprovals")
  )
    result.updated.push("edgeMintApprovals");
  return result;
}

async function applyRepoManifest(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl,
  ingest: Ingest,
): Promise<ResyncResult> {
  const read = await readLinkedManifest(env, db, slug, now, fetchImpl);
  if (!read.ok)
    return {
      ok: false,
      error: read.error,
      ...(read.errors ? { errors: read.errors } : {}),
    };
  const {
    product,
    owner,
    repo,
    cfg,
    files,
    token,
    commit: appliedSha,
    manifest,
    warnings,
  } = read;

  const result = await ingest.run(env, db, {
    mode: "apply",
    product: slug,
    manifest,
    now,
    warnings,
    source: {
      origin: "resync",
      sha: appliedSha,
      files,
      fetchImpl,
      repo: {
        owner,
        name: repo,
        installId: cfg.gh_installation_id ?? null,
        identity: () => getRepoIdentity(token, owner, repo, fetchImpl),
        hasFile: async () => false,
        blob: repoBlobLookup(token, owner, repo, appliedSha, fetchImpl),
      },
    },
    seed: { product, releaseConfig: cfg },
  });
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    updated: result.updated,
    ...(result.refused ? { refused: result.refused } : {}),
    ...(result.claimed ? { claimed: result.claimed } : {}),
    ...(result.conflicts ? { conflicts: result.conflicts } : {}),
    ...(result.packSets ? { packSets: result.packSets as StoreOutcome } : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.breakGlass ? { breakGlass: result.breakGlass } : {}),
    ...(result.breakGlassEnded
      ? { breakGlassEnded: result.breakGlassEnded }
      : {}),
    ...feedSkipped(result.facts),
  };
}

/** The `feedProvisionSkipped` answer field from an ingest's facts (F-34.2), or nothing. */
export function feedSkipped(facts: Record<string, unknown>): {
  feedProvisionSkipped?: { ecosystem: string; reason: string }[];
} {
  const skipped = (
    facts.feedProvision as
      | { skipped?: { ecosystem: string; reason: string }[] }
      | undefined
  )?.skipped;
  return skipped && skipped.length > 0 ? { feedProvisionSkipped: skipped } : {};
}

/**
 * Which pre-write check refused a read of a linked product's manifest. A subset of
 * `linkExisting.ts`'s `LinkCheck`, so the resync dry run can name it the way link does.
 */
export type LinkedManifestCheck = "product" | "app" | "manifest" | "slug";

export type LinkedManifestRead =
  | {
      ok: true;
      /** The product row as read before the GitHub round trips (ST-01b compares its fields). */
      product: ProductRow;
      owner: string;
      repo: string;
      /** The product's `release_config` row the coordinates came from. */
      cfg: ReleaseConfigRow;
      /** The `.pkey/` documents as read (the manifest snapshot records them). */
      files: Record<string, string>;
      /** The repo-scoped installation token the read used. */
      token: string;
      /** The default-branch commit every document was read at (ST-01a). */
      commit: string;
      manifest: ParsedManifest;
      /** The validator's warnings for the documents (ST-17): carried into the plan. */
      warnings: PlanWarning[];
    }
  | {
      ok: false;
      check: LinkedManifestCheck;
      error: string;
      errors?: string[];
    };

/**
 * The read half of a resync, shared by `resyncRepo` and the console's dry run (`planResync`,
 * UX-78) so the plan the operator confirms is read exactly as the resync reads it: the product
 * must be linked, the coordinates come from `release_config`, the token is scoped to that one
 * repository, every document is read at ONE GitHub-resolved commit of the default branch
 * (ST-01a, R6-05: nothing caller-supplied chooses the ref), parsed with the platform's
 * reserved-name severity, and the manifest must name this product. Writes nothing.
 */
export async function readLinkedManifest(
  env: Env,
  db: Db,
  slug: string,
  now: number,
  fetchImpl: FetchImpl,
): Promise<LinkedManifestRead> {
  const product = await getProduct(db, slug);
  if (!product)
    return { ok: false, check: "product", error: "unknown product" };
  if (product.release_source !== "github")
    return {
      ok: false,
      check: "product",
      error: "product is not linked to a repo",
    };

  const cfg = await getReleaseConfig(db, slug);
  if (!cfg || !cfg.gh_owner || !cfg.gh_repo)
    return {
      ok: false,
      check: "product",
      error: "product has no linked repo coordinates",
    };
  const owner = cfg.gh_owner;
  const repo = cfg.gh_repo;

  let token: string;
  try {
    const installId =
      cfg.gh_installation_id ??
      (await discoverInstallation(env, owner, repo, now, fetchImpl));
    // Structured scope, not a bare repo name — the string form is the legacy path and
    // yields an installation-wide token plus a second cache entry (R5-03).
    token = await getInstallationToken(
      env,
      { owner, repo },
      installId,
      now,
      fetchImpl,
    );
  } catch (err) {
    return {
      ok: false,
      check: "app",
      error: err instanceof Error ? err.message : "github access failed",
    };
  }

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
    return {
      ok: false,
      check: "manifest",
      error:
        err instanceof Error ? err.message : "github manifest fetch failed",
    };
  }

  const result = parseManifest(files, {
    reservedNames: await reservedNamesMode(env, db),
    reservedDisplayNames: await reservedDisplayNamesMode(env, db),
  });
  if (!result.ok)
    return {
      ok: false,
      check: "manifest",
      error: "manifest validation failed",
      errors: result.errors,
    };
  const manifest = result.manifest;
  if (manifest.product.slug !== slug)
    return {
      ok: false,
      check: "slug",
      error: `manifest slug ${manifest.product.slug} does not match product ${slug}`,
    };
  return {
    ok: true,
    product,
    owner,
    repo,
    cfg,
    files,
    token,
    commit,
    manifest,
    warnings: result.warnings,
  };
}
