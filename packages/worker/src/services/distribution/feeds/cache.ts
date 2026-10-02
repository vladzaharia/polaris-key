/// <reference types="@cloudflare/workers-types" />

/**
 * The storefront feeds' answer cache (P2b-05). The feed routes are public and unauthenticated,
 * and a selection reads Release's history (`select.ts`), so what they render is kept in the
 * Workers Cache API (`caches.default`, per data centre) for the five minutes the `Cache-Control`
 * header already promises clients.
 *
 *   - THE KEY is the feed's path and its `?outlet=` (nothing else from the query: an attacker
 *     cannot miss the cache by adding parameters), plus a STAMP of the state that decides what a
 *     feed lists and that must take effect at once: every rollout on the product (a halt or a
 *     pause withdraws a release from the feeds immediately, not five minutes later), the yanks,
 *     the stored availability reports, the outlets, the registered F-Droid files, and whether
 *     release notes are public. A change to any of them is a new key. A new release reaches the
 *     feeds within five minutes.
 *   - THE ACCESS CHECK is never cached: a route reads the delivery access (`feedReaders`) before
 *     it looks here, so a deliverable made non-public has no feed from that request on.
 *   - Only a rendered answer is stored, never a not-found.
 *   - Where there is no Cache API (Node tests) or it throws, the answer is computed every time.
 */

import type { Db } from "../../../core/platform.js";
import type { ReleaseCatalog } from "../../../core/hooks.js";

// The cache itself is Core's since P3-09 (Update's app-updater feeds share it).
export {
  cachedFeedText,
  FEED_CACHE_SECONDS,
  feedCacheKey,
} from "../../../core/feedCache.js";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The stamp of the state a feed must follow at once (see the file comment): three D1 reads.
 */
export async function feedStateStamp(
  db: Db,
  product: string,
  catalog: ReleaseCatalog,
  notesPublic: boolean,
): Promise<string> {
  const rollouts = await db.all<Record<string, unknown>>(
    `SELECT deliverable_id, outlet_id, channel, release_id, rollout_bp, state, updated_at
       FROM dist_rollouts WHERE product = ?
      ORDER BY deliverable_id, outlet_id, channel`,
    product,
  );
  const counts = await db.first<Record<string, unknown>>(
    `SELECT (SELECT COUNT(*) FROM dist_availability WHERE product = ?) AS an,
            (SELECT COALESCE(MAX(updated_at), 0) FROM dist_availability WHERE product = ?) AS at,
            (SELECT COUNT(*) FROM dist_feed_files WHERE product = ?) AS fn,
            (SELECT COALESCE(MAX(updated_at), 0) FROM dist_feed_files WHERE product = ?) AS ft,
            (SELECT COUNT(*) || ':' || COALESCE(MAX(modified_at), 0) || ':' ||
                    COALESCE(MAX(removed_at), 0) || ':' || COUNT(removed_at)
               FROM dist_outlets WHERE product = ?) AS o`,
    product,
    product,
    product,
    product,
    product,
  );
  const yanks = (await catalog.yanks()).map((y) => y.releaseId).sort();
  return (
    await sha256Hex(JSON.stringify({ rollouts, counts, yanks, notesPublic }))
  ).slice(0, 32);
}
