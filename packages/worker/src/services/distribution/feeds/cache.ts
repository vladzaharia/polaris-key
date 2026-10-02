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

/** How long a rendered answer is kept: the `max-age` the feed responses carry. */
export const FEED_CACHE_SECONDS = 300;

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

function store(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** The cache key of one feed answer: `origin` + `path` + `?outlet=` + the state stamp. */
export function feedCacheKey(
  origin: string,
  path: string,
  outlet: string | null,
  stamp: string,
): string {
  const q = new URLSearchParams();
  if (outlet) q.set("outlet", outlet);
  q.set("state", stamp);
  return `${origin}/__pkey-feed-cache${path}?${q.toString()}`;
}

/**
 * `compute()`'s text, from the cache when it holds it. A `null` answer (not-found) is never
 * stored. Cache failures fall through to computing.
 */
export async function cachedFeedText(
  key: string,
  compute: () => Promise<string | null>,
): Promise<string | null> {
  const cache = store();
  const req = new Request(key);
  if (cache) {
    const hit = await cache.match(req).catch(() => undefined);
    if (hit) return hit.text();
  }
  const text = await compute();
  if (text !== null && cache)
    await cache
      .put(
        req,
        new Response(text, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": `public, max-age=${FEED_CACHE_SECONDS}`,
          },
        }),
      )
      .catch(() => undefined);
  return text;
}
