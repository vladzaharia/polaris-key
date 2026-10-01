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
import { listReleasePages, RELEASE_PAGE_CAP, type Release } from "./github.js";
import {
  getReleaseConfig,
  isResolved,
  type ReleaseConfigRow,
} from "./config.js";
import { floorRelease, installationToken } from "./gateway.js";
import {
  listChannelFloors,
  listStoredReleaseIds,
  releaseStoreStatements,
  type ReleaseChannelFloorRow,
} from "./store.js";
import { semverOfTag } from "./channels.js";
import type { ManifestAppDeliverable } from "@polaris-key/manifest";
import { ingestGithubDescriptors, readAppDeliverable } from "./descriptor.js";

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
 * builder, which raises them conditionally on what it read. So are the release ids the store
 * already holds: when the list was read to its end, the builder marks any of them that GitHub no
 * longer publishes as `absentUpstream` (P0-03). A capped read hands it `null` instead.
 *
 * Release descriptors (P2-04): a release carrying a `pkey-release.json` with no ingested
 * descriptor yet is ingested in the same pass (`ingestGithubDescriptors`, a bounded number per
 * sync), and the product's declared artifact map — `app`, when the caller has just parsed it,
 * else the persisted declaration — replaces filename sniffing for every other release. The
 * described releases' rows go FIRST in the returned list (so an explicit `seq` is taken before
 * the store numbers new releases) and their builds and files LAST (after the rows they enrich).
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
  opts: { app?: ManifestAppDeliverable | null } = {},
): Promise<DbStatement[]> {
  if (!isResolved(cfg)) return [];
  try {
    const floors = await listChannelFloors(db, cfg.product);
    const stored = await listStoredReleaseIds(db, cfg.product);
    const app =
      opts.app !== undefined
        ? opts.app
        : await readAppDeliverable(db, cfg.product);
    const token = await installationToken(env, cfg, now, fetchImpl);
    const listing = await listReleasePages(
      token,
      cfg.gh_owner,
      cfg.gh_repo,
      100,
      fetchImpl,
      { maxPages: RELEASE_PAGE_CAP.sync },
    );
    const held = await heldFloorReleases(
      token,
      cfg,
      floors,
      listing.releases,
      fetchImpl,
    );
    const descriptors = await ingestGithubDescriptors(
      db,
      cfg,
      token,
      listing.releases,
      app,
      now,
      fetchImpl,
    );
    return [
      ...descriptors.head,
      ...releaseStoreStatements(
        cfg.product,
        cfg,
        listing.releases,
        now,
        floors,
        held,
        listing.complete ? stored : null,
        {
          app,
          described: descriptors.described,
          refused: descriptors.refused,
        },
      ),
      ...descriptors.tail,
    ];
  } catch {
    // No log line: the worker carries no logging sink by design. The absence of a `releases`
    // entry in the sync result — and `release_health`'s unchanged `checked_at` — is the signal.
    return [];
  }
}

/**
 * The floor releases a CAPPED release list did not reach, looked up by tag exactly as the live
 * route does (`floorRelease`). A list shorter than the cap is the whole repository, so a floor
 * release missing from it is gone and costs nothing more; only a repo above
 * `RELEASE_PAGE_CAP.sync` pages pays one tag lookup per floor it did not see. Without this the
 * store said `blocked` for a channel the live route still served through that same lookup
 * (P2-03, wave-1 sync). A lookup that fails is treated as "not found" — the store keeps its
 * conservative answer rather than failing the whole sync.
 */
async function heldFloorReleases(
  token: string,
  cfg: Parameters<typeof floorRelease>[1],
  floors: ReleaseChannelFloorRow[],
  listed: Release[],
  fetchImpl: FetchImpl,
): Promise<Release[]> {
  if (floors.length === 0 || listed.length < 100 * RELEASE_PAGE_CAP.sync)
    return [];
  const held: Release[] = [];
  for (const floor of floors) {
    const seen = floor.release_id
      ? listed.some((r) => r.tag_name === floor.release_id)
      : listed.some((r) => semverOfTag(r.tag_name) === floor.version);
    if (seen) continue;
    const found = await floorRelease(token, cfg, floor, fetchImpl).catch(
      () => null,
    );
    if (found && !found.draft) held.push(found);
  }
  return held;
}

/**
 * Refresh one product's truth store from GitHub, standalone.
 *
 * Used by `linkRepo` (whose own batch has to create the `products` row before anything can
 * reference it), by the release admin surface, and by the GitHub `release` webhook (P0-03), which
 * refreshes only these four tables and never re-reads `.pkey/`. Returns how many statements were
 * applied, so a caller can tell "synced nothing" from "did not run".
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
