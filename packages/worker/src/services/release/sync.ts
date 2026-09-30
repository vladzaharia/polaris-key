/// <reference types="@cloudflare/workers-types" />

/**
 * The sync surface — how a linked GitHub repo becomes rows Polaris Key serves.
 *
 * ── WHAT THIS MODULE IS ─────────────────────────────────────────────────────────────────────
 *
 * The plan's §2.1 file map calls for one `sync.ts` wiring github / githubApp / linkRepo /
 * resync / manifestFiles. This is it: the platform-facing FAÇADE over those five, plus the one
 * piece of behaviour P2.T2 adds — populating the release truth store from the same GitHub read
 * the manifest sync already performs.
 *
 * `linkRepo.ts` and `resync.ts` keep their own files (they are ~900 lines of manifest ingestion
 * between them, and folding that in would make this module unreviewable). What lives here is the
 * boundary: `admin/handlers/products.ts` and `githubWebhook.ts` import from `sync.js` and know
 * nothing about the layout behind it.
 *
 * ── WHY INGESTION LIVES IN THE SERVICE AT ALL ───────────────────────────────────────────────
 *
 * A repo link IS Release's front door — the coordinates, the installation token, the
 * `.pkey/` read. But what it WRITES is the whole product (catalog, tiers, profiles, OIDC,
 * edge-mint), almost none of which is Release's data. Since a service may only import `core/`,
 * those writers are reached through `core/ingest.ts`, a core-owned COUNTABLE re-export — the
 * same shape `core/data.ts` gives License and Config. See that file's header.
 */

import type { Db, DbStatement, Env } from "../../core/platform.js";
import type { FetchImpl } from "./githubApp.js";
import { listReleases, RELEASE_PAGE_CAP } from "./github.js";
import {
  getReleaseConfig,
  isResolved,
  type ReleaseConfigRow,
} from "./config.js";
import { installationToken } from "./gateway.js";
import { listChannelFloors, releaseStoreStatements } from "./store.js";

// ── The platform-facing façade ───────────────────────────────────────────────

export { linkRepo, manifestIssuerRefusal, parseRepoUrl } from "./linkRepo.js";
export type { LinkRepoResult } from "./linkRepo.js";
export { resyncRepo } from "./resync.js";
export type { ResyncResult } from "./resync.js";
export {
  isManifestPath,
  MANIFEST_DIR,
  MANIFEST_FILES,
} from "./manifestFiles.js";
export type { ManifestFileName } from "./manifestFiles.js";
export { MAX_MANIFEST_BYTES, parseManifest } from "./manifest.js";
export type { FetchImpl } from "./githubApp.js";
export { checkReleaseHealth } from "./health.js";
export type { ReleaseHealth } from "./health.js";
export { getReleaseConfig } from "./config.js";

// ── Truth-store ingestion (P2.T2) ────────────────────────────────────────────

/**
 * The statements that bring `release_metadata` / `release_artifacts` / `release_channels` /
 * `release_health` up to date with what GitHub currently publishes.
 *
 * One paginated `listReleases` read per sync — up to `RELEASE_PAGE_CAP.sync` pages of 100
 * (1,000 releases), following `Link: rel="next"`, so a busy repo cannot push its last stable
 * release off the store (P0-02) — and no per-asset requests: everything the store records is
 * carried in those responses. A repo with fewer than 100 releases still costs ONE call. That
 * bound matters, because a sync is triggered by a repo push and the installation quota is
 * 5,000/hour for every product on the installation (R10-05).
 *
 * The channel floors (R6-10) are read here, before the fetch, and handed to the pure statement
 * builder, which raises them conditionally on what it read.
 *
 * Returns `[]` — never throws, never partially applies — when the product has no GitHub
 * coordinates or GitHub is unavailable. The truth store is a CACHE of upstream state; failing a
 * whole manifest resync (which may be carrying a security-relevant change to tiers or OIDC)
 * because a release list timed out would be the wrong trade. The caller reports whether the
 * step ran.
 */
export async function releaseStoreSyncStatements(
  env: Env,
  db: Db,
  cfg: ReleaseConfigRow,
  now: number,
  fetchImpl: FetchImpl,
): Promise<DbStatement[]> {
  if (!isResolved(cfg)) return [];
  try {
    const floors = await listChannelFloors(db, cfg.product);
    const token = await installationToken(env, cfg, now, fetchImpl);
    const releases = await listReleases(
      token,
      cfg.gh_owner,
      cfg.gh_repo,
      100,
      fetchImpl,
      { maxPages: RELEASE_PAGE_CAP.sync },
    );
    return releaseStoreStatements(cfg.product, cfg, releases, now, floors);
  } catch {
    // No log line: the worker carries no logging sink by design. The absence of a `releases`
    // entry in the sync result — and `release_health`'s unchanged `checked_at` — is the signal.
    return [];
  }
}

/**
 * Refresh one product's truth store from GitHub, standalone.
 *
 * Used by `linkRepo` (whose own batch has to create the `products` row before anything can
 * reference it) and by the release admin surface. Returns how many statements were applied, so
 * a caller can tell "synced nothing" from "did not run".
 */
export async function syncReleaseStore(
  env: Env,
  db: Db,
  product: string,
  now: number,
  fetchImpl: FetchImpl = fetch,
): Promise<number> {
  const cfg = await getReleaseConfig(db, product);
  if (!cfg) return 0;
  const stmts = await releaseStoreSyncStatements(env, db, cfg, now, fetchImpl);
  if (stmts.length > 0) await db.batch(stmts);
  return stmts.length;
}
