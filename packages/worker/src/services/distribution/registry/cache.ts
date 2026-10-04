/// <reference types="@cloudflare/workers-types" />
/**
 * Registry answers through the Workers Cache API, with the headers of plans/F-01.md §6.7 (F-02).
 *
 * | Answer                                   | `Cache-Control` (public mode)                   | ETag                     |
 * | ---------------------------------------- | ----------------------------------------------- | ------------------------ |
 * | content-addressed bytes                  | `public, max-age=31536000, immutable`           | `"<sha256>"`             |
 * | index documents                          | `public, max-age=60, stale-while-revalidate=60` | strong, the body SHA-256 |
 * | not-found and refusals                   | `no-store`                                      | none                     |
 * | any non-public mode                      | `private, no-store`                             | none                     |
 *
 *   - THE ACCESS CHECK IS NEVER CACHED. A route runs `authorizeFeedRead` first and only a
 *     `cache: "public"` decision may reach `cachedRegistryAnswer`; a private answer is
 *     computed every time and never stored (§6.6 step 6).
 *   - THE KEY is the normalised URL: the path with percent-escapes upper-cased (npm's `%2f` and
 *     `%2F` are one key), only the query names the route reads, and, for npm and PyPI, the
 *     `Accept` header, because those two answer different documents by it.
 *   - Only a 200 whose `Cache-Control` is public is stored, never a not-found or a refusal.
 *   - Where there is no Cache API (Node tests) or it throws, the answer is computed every time.
 */

import type { RegistryEcosystem } from "../../../core/registryHost.js";

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const INDEX_CACHE_CONTROL =
  "public, max-age=60, stale-while-revalidate=60";
export const PRIVATE_CACHE_CONTROL = "private, no-store";

/** What kind of answer a route is giving, for its headers. */
export type RegistryAnswerKind = "immutable" | "index";

/** The `Cache-Control` and `ETag` of a successful answer (§6.7). `sha256` is the object's
 *  SHA-256 for immutable bytes and the body's for an index document. */
export function registryCacheHeaders(
  cache: "public" | "private",
  kind: RegistryAnswerKind,
  sha256: string,
): Record<string, string> {
  if (cache === "private") return { "cache-control": PRIVATE_CACHE_CONTROL };
  return {
    "cache-control":
      kind === "immutable" ? IMMUTABLE_CACHE_CONTROL : INDEX_CACHE_CONTROL,
    etag: `"${sha256}"`,
  };
}

/** Ecosystems whose answer depends on `Accept`. */
const ACCEPT_KEYED: ReadonlySet<RegistryEcosystem> = new Set(["npm", "pypi"]);

/** `Accept`, normalised for a key: lower-case, no whitespace. */
function normalisedAccept(req: Request): string {
  return (req.headers.get("accept") ?? "").toLowerCase().replace(/\s+/g, "");
}

/** Upper-case the hex of every percent-escape, so equivalent spellings share a key. */
function normalisedPath(pathname: string): string {
  return pathname.replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase());
}

/**
 * The cache key of one registry answer: the request's origin and normalised path, the named
 * query inputs (in the order given, empty ones dropped) and, for npm and PyPI, `Accept`. Any
 * other query parameter or header is ignored, so an attacker cannot miss the cache by adding
 * one, nor poison one variant from another.
 */
export function registryCacheKey(
  req: Request,
  ecosystem: RegistryEcosystem,
  queryNames: readonly string[] = [],
): string {
  const url = new URL(req.url);
  const q = new URLSearchParams();
  for (const name of queryNames) {
    const v = url.searchParams.get(name);
    if (v) q.set(name, v);
  }
  if (ACCEPT_KEYED.has(ecosystem)) q.set("__accept", normalisedAccept(req));
  const query = q.toString();
  return `${url.origin}/__pkey-registry-cache${normalisedPath(url.pathname)}${query ? `?${query}` : ""}`;
}

function store(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** Is `res` storable: a 200 with a public `Cache-Control`. */
function storable(res: Response): boolean {
  return (
    res.status === 200 &&
    /^\s*public\b/i.test(res.headers.get("cache-control") ?? "")
  );
}

/** `res` without its body, for a HEAD. */
function headOf(res: Response): Response {
  return new Response(null, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * A 304 when `req`'s `If-None-Match` names `res`'s ETag (or `*`), else `res` itself. Only a 200
 * with an ETag can become a 304.
 */
export function conditional(req: Request, res: Response): Response {
  const etag = res.headers.get("etag");
  const inm = req.headers.get("if-none-match");
  if (res.status !== 200 || etag === null || inm === null) return res;
  const wanted = inm.split(",").map((t) => t.trim().replace(/^W\//, ""));
  if (!wanted.includes(etag) && !wanted.includes("*")) return res;
  void res.body?.cancel().catch(() => undefined);
  const headers = new Headers();
  for (const name of ["etag", "cache-control", "vary"]) {
    const v = res.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  return new Response(null, { status: 304, headers });
}

/**
 * The answer for a PUBLIC read, from the Cache API when it holds one, else `compute()`'s,
 * stored when storable. HEAD reads the GET entry and drops the body; `If-None-Match` becomes a
 * 304. Call it only after `authorizeFeedRead` returned `cache: "public"`.
 *
 * Only a GET ever writes the entry. A HEAD may read it but never stores `compute()`'s answer,
 * because a route may answer HEAD with an empty body, and storing that under the GET key would
 * serve an empty 200 to every later GET for as long as the entry lives.
 */
export async function cachedRegistryAnswer(
  req: Request,
  key: string,
  compute: () => Promise<Response>,
): Promise<Response> {
  const cache = store();
  const keyReq = new Request(key, { method: "GET" });
  const finish = (res: Response): Response =>
    conditional(req, req.method === "HEAD" ? headOf(res) : res);
  if (cache) {
    const hit = await cache.match(keyReq).catch(() => undefined);
    if (hit) return finish(hit);
  }
  const res = await compute();
  if (cache && req.method === "GET" && storable(res)) {
    await cache.put(keyReq, res.clone()).catch(() => undefined);
  }
  return finish(res);
}
