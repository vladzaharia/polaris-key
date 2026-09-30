/// <reference types="@cloudflare/workers-types" />
/**
 * Host isolation for the bytes host (P2-01).
 *
 * The bytes host (`BLOB_ORIGIN`, e.g. `https://dl.plrs.im`) is the same Worker on a second
 * custom domain. A request that arrives there reaches ONLY the routes listed in `BYTE_ROUTES`;
 * everything else — `/manage`, `/docs`, the portal, discovery, every service route — answers the
 * ordinary not-found. P2-05 and P2b-04 add the first byte routes; P2-01 adds none.
 *
 * WHY THIS IS STRICT (owner decision, recorded in `docs/security/THREAT-MODEL.md` §3): the
 * bytes host is `dl.plrs.im`, a sibling of the console at `key.plrs.im`, so the two are
 * SAME-SITE. `SameSite` cookies therefore do not separate them, and anything able to run script
 * as `dl.plrs.im` could make same-site requests to the console; the compensations live here and
 * in `blobs.ts`, and are test-pinned (`test/bytesHost.test.ts`):
 *   - every response carries `X-Content-Type-Options: nosniff` and `BLOB_CSP` (`sandbox`), so
 *     a body a browser chose to render still runs no script and has an opaque origin;
 *   - a byte route's non-error answer must carry a type on the explicit inert allowlist
 *     (`BYTES_HOST_TYPES`) — anything else, a missing type on a body included, is replaced
 *     with not-found — and leaves as `Content-Disposition: attachment` unless the route asked
 *     for `inline`; an error answer may be JSON (the platform's `{"error":…}` bodies) or an
 *     allowlisted type, never HTML, XML, SVG, script or text;
 *   - a route's own `Access-Control-*` headers are dropped; only `core/cors.ts` sets them;
 *   - no cookie is read (the `Cookie` header is stripped before a route sees the request) and
 *     none is set (`Set-Cookie` is stripped from every response);
 *   - the console's session cookies are host-only (`__Host-` prefix, no `Domain`), so the
 *     browser never sends them to `dl.plrs.im` in the first place.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { notFound } from "./errors.js";
import { BLOB_CSP, BYTES_HOST_TYPES } from "./blobs.js";
import { corsPreflight, withCors } from "./cors.js";
import { loadProduct, type Product } from "./products.js";

/**
 * What a byte route's `match` returns: the product that owns the path, plus its parameters.
 * Every byte route is product-scoped — a key is served only when THIS product holds a ref to
 * it (`blobs.ts` `hasRef`) — and the product is also what decides CORS (`core/cors.ts`).
 */
export interface ByteRouteMatch {
  readonly product: string;
  readonly params: Record<string, string>;
}

/** What a byte route's handler receives once its product has loaded. */
export interface ByteRouteContext {
  readonly env: Env;
  readonly db: Db;
  readonly product: Product;
  readonly params: Record<string, string>;
  readonly now: number;
}

/** One route that may answer on the bytes host. */
export interface ByteRoute {
  /** For logs and tests. */
  readonly name: string;
  /** The owning product and path parameters when the route handles `pathname`, else `null`. */
  match(pathname: string): ByteRouteMatch | null;
  handle(req: Request, ctx: ByteRouteContext): Promise<Response>;
}

/**
 * The bytes-host allowlist. EMPTY in P2-01 by design: P2-05 (release byte routes) and P2b-04
 * (distribution) register theirs here. A route not listed here does not exist on the host.
 */
export const BYTE_ROUTES: readonly ByteRoute[] = [];

/**
 * A hostname in the form hosts are compared in: lowercase, with any trailing dots removed.
 * `dl.plrs.im.` (the fully-qualified form) is the same DNS name as `dl.plrs.im`, and the edge
 * routes it to this Worker with the dot still in `req.url` — so an exact comparison would let
 * `https://dl.plrs.im./manage` skip host isolation and reach the console.
 */
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

/** The bytes host's hostname (lowercase, no trailing dot), or `null` when `BLOB_ORIGIN` is
 *  unset or unusable. */
export function bytesHostname(env: Pick<Env, "BLOB_ORIGIN">): string | null {
  const origin = env.BLOB_ORIGIN;
  if (typeof origin !== "string" || origin.trim() === "") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return normalizeHostname(u.hostname) || null;
  } catch {
    return null;
  }
}

/** True when `url` is on the bytes host, in any case and with or without the trailing dot.
 *  Always false with `BLOB_ORIGIN` unset. */
export function isBytesHost(url: URL, env: Pick<Env, "BLOB_ORIGIN">): boolean {
  const host = bytesHostname(env);
  return host !== null && normalizeHostname(url.hostname) === host;
}

/** Refused on the bytes host whatever the status or the allowlist says: anything a browser may
 *  execute or render as an active document. */
const EXECUTABLE_TYPE =
  /html|xml|svg|script|ecmascript|^\s*text\/|multipart\//i;
/** The platform's error bodies (`core/errors.ts`). Allowed only at status 400 and above: the
 *  bytes host serves bytes, not documents. */
const ERROR_JSON_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/problem+json",
]);

function baseType(t: string): string {
  return (t.split(";")[0] ?? "").trim().toLowerCase();
}

/**
 * The host-wide type rule, applied to every route answer whatever produced it (`blobResponse`
 * applies the same allowlist, but a route need not use it — the boundary lives here, as
 * R1-09's `secureResponse` does for the console):
 *   - executable or renderable types are refused at every status;
 *   - below 400, a `Content-Type` must be on `BYTES_HOST_TYPES`, and a body must have one;
 *   - at 400 and above, a body's type must be the platform's JSON error type or allowlisted.
 * A body-less answer with no type (304, 204, a 416 or 405 from `blobResponse`) passes.
 */
function refusedType(res: Response): boolean {
  const raw = res.headers.get("content-type");
  if (raw !== null && EXECUTABLE_TYPE.test(raw)) return true;
  const type = raw === null ? "" : baseType(raw);
  if (type === "") return res.body !== null;
  if (BYTES_HOST_TYPES.has(type)) return false;
  return !(res.status >= 400 && ERROR_JSON_TYPES.has(type));
}

/** `inline` only when the route asked for it on an allowlisted type; else `attachment`,
 *  keeping the route's parameters (the filename). */
function forcedDisposition(res: Response): string | null {
  if (res.status >= 400) return null;
  const type = baseType(res.headers.get("content-type") ?? "");
  if (type === "" && res.body === null) return null;
  const disp = res.headers.get("content-disposition") ?? "";
  if (/^\s*inline\s*(;|$)/i.test(disp) && BYTES_HOST_TYPES.has(type))
    return null;
  if (/^\s*attachment\s*(;|$)/i.test(disp)) return null;
  const params = /^\s*inline\s*;(.*)$/i.exec(disp)?.[1];
  return params !== undefined ? `attachment;${params}` : "attachment";
}

/**
 * The route's answer with the host's own headers enforced: no `Access-Control-*` of its own
 * (CORS is `core/cors.ts`'s alone, and `withCors` leaves a product with no `web.origins`
 * untouched, so a route's own `*` would otherwise survive), and a forced disposition.
 */
function policed(res: Response): Response {
  const disposition = forcedDisposition(res);
  let touched = disposition !== null;
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("access-control-")) touched = true;
    else headers.append(key, value);
  });
  if (!touched) return res;
  if (disposition !== null) headers.set("content-disposition", disposition);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * The headers every bytes-host response leaves with. Applied to not-found answers as well as
 * byte responses, so no response on the host is ever missing them.
 */
export function hardenBytesHostResponse(res: Response): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", BLOB_CSP);
  headers.set("referrer-policy", "no-referrer");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** The request a byte route sees: identical, minus any `Cookie` header. */
function withoutCookies(req: Request): Request {
  if (!req.headers.has("cookie")) return req;
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  return new Request(req, { headers });
}

/**
 * Dispatch a request that arrived on the bytes host. Only `routes` can answer; anything else,
 * an unknown product, and any route answer whose type breaks the host's rule (`refusedType`),
 * becomes the plain not-found.
 *
 * CORS (P0-05) runs here exactly as `dispatch.ts` runs it for the console's covered routes:
 * the product's own `web.origins` decide; a preflight is answered before the handler runs (so
 * it cannot probe anything the handler would decide); and the headers are added only after the
 * handler returns, so nothing a handler caches carries one origin's allow header to the next.
 * Credentials are never allowed — and there are none to allow, since no cookie reaches a route.
 */
export async function dispatchBytesHost(
  req: Request,
  env: Env,
  db: Db,
  routes: readonly ByteRoute[] = BYTE_ROUTES,
): Promise<Response> {
  return hardenBytesHostResponse(await answer(req, env, db, routes));
}

async function answer(
  req: Request,
  env: Env,
  db: Db,
  routes: readonly ByteRoute[],
): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  for (const route of routes) {
    const matched = route.match(pathname);
    if (!matched) continue;
    const product = await loadProduct(env, db, matched.product);
    if (!product) return notFound();
    if (req.method === "OPTIONS") return corsPreflight(product, req);
    let res = await route.handle(withoutCookies(req), {
      env,
      db,
      product,
      params: matched.params,
      now: Math.floor(Date.now() / 1000),
    });
    // A refused type is replaced silently: the worker logs nothing (R12), and the not-found
    // answer is indistinguishable from a route that does not exist.
    if (refusedType(res)) {
      await res.body?.cancel().catch(() => undefined);
      res = notFound();
    }
    return withCors(product, req, policed(res));
  }
  return notFound();
}
