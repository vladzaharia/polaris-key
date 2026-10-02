/// <reference types="@cloudflare/workers-types" />

/**
 * The feed answer cache (P2b-05, moved to Core by P3-09 so Distribution's storefront feeds and
 * Update's app-updater feeds share it). A public, unauthenticated feed is rendered from Release's
 * history, so what it renders is kept in the Workers Cache API (`caches.default`, per data
 * centre) for the five minutes the `Cache-Control` header already promises clients.
 *
 *   - THE KEY is built by the caller from the feed's path, only the query inputs its renderer
 *     reads (an attacker cannot miss the cache by adding parameters), and a STAMP of the state
 *     that must take effect at once (Distribution's `feedStateStamp`: a halt or a yank withdraws
 *     a release from every feed immediately, not five minutes later).
 *   - THE ACCESS CHECK is never cached: a route decides access before it looks here.
 *   - Only a rendered answer is stored, never a not-found.
 *   - Where there is no Cache API (Node tests) or it throws, the answer is computed every time.
 */

/** How long a rendered answer is kept: the `max-age` the feed responses carry. */
export const FEED_CACHE_SECONDS = 300;

function store(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * The cache key of one feed answer: `origin` + `path` + the named query inputs (in the order
 * given, empty ones dropped) + the state stamp.
 */
export function feedCacheKey(
  origin: string,
  path: string,
  outlet: string | null,
  stamp: string,
  inputs: ReadonlyArray<readonly [string, string | null | undefined]> = [],
): string {
  const q = new URLSearchParams();
  if (outlet) q.set("outlet", outlet);
  for (const [k, v] of inputs) if (v) q.set(k, v);
  q.set("state", stamp);
  return `${origin}/__pkey-feed-cache${path}?${q.toString()}`;
}

async function cached<T>(
  key: string,
  compute: () => Promise<T | null>,
  read: (res: Response) => Promise<T>,
  body: (value: T) => BodyInit,
): Promise<T | null> {
  const cache = store();
  const req = new Request(key);
  if (cache) {
    const hit = await cache.match(req).catch(() => undefined);
    if (hit) return read(hit);
  }
  const value = await compute();
  if (value !== null && cache)
    await cache
      .put(
        req,
        new Response(body(value), {
          headers: {
            "content-type": "application/octet-stream",
            "cache-control": `public, max-age=${FEED_CACHE_SECONDS}`,
          },
        }),
      )
      .catch(() => undefined);
  return value;
}

/**
 * `compute()`'s text, from the cache when it holds it. A `null` answer (not-found) is never
 * stored. Cache failures fall through to computing.
 */
export function cachedFeedText(
  key: string,
  compute: () => Promise<string | null>,
): Promise<string | null> {
  return cached(
    key,
    compute,
    (r) => r.text(),
    (v) => v,
  );
}

/** `cachedFeedText` for a binary answer (the rewritten `.zsync` control file, P3-09). */
export function cachedFeedBytes(
  key: string,
  compute: () => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  return cached(
    key,
    compute,
    async (r) => new Uint8Array(await r.arrayBuffer()),
    (v) => v,
  );
}
