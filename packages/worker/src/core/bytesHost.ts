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
 * as `dl.plrs.im` could make same-site requests to the console. The compensations live here and
 * in `blobs.ts`, and are test-pinned (`test/bytesHost.test.ts`):
 *   - every response carries `X-Content-Type-Options: nosniff` and `BLOB_CSP` (`sandbox`), so
 *     a body a browser chose to render still runs no script and has an opaque origin;
 *   - a byte route may never answer with an executable or renderable type (HTML, XML, SVG,
 *     script, JSON, text) — the dispatcher replaces such a response with not-found;
 *   - no cookie is read (the `Cookie` header is stripped before a route sees the request) and
 *     none is set (`Set-Cookie` is stripped from every response);
 *   - the console's session cookies are host-only (`__Host-` prefix, no `Domain`), so the
 *     browser never sends them to `dl.plrs.im` in the first place.
 */

import type { Env } from "../env.js";
import { notFound } from "./errors.js";
import { BLOB_CSP } from "./blobs.js";

/** One route that may answer on the bytes host. */
export interface ByteRoute {
  /** For logs and tests. */
  readonly name: string;
  /** Path parameters when the route handles `pathname`, else `null`. */
  match(pathname: string): Record<string, string> | null;
  handle(
    req: Request,
    env: Env,
    params: Record<string, string>,
  ): Promise<Response>;
}

/**
 * The bytes-host allowlist. EMPTY in P2-01 by design: P2-05 (release byte routes) and P2b-04
 * (distribution) register theirs here. A route not listed here does not exist on the host.
 */
export const BYTE_ROUTES: readonly ByteRoute[] = [];

/** The bytes host's hostname (lowercase), or `null` when `BLOB_ORIGIN` is unset or unusable. */
export function bytesHostname(env: Pick<Env, "BLOB_ORIGIN">): string | null {
  const origin = env.BLOB_ORIGIN;
  if (typeof origin !== "string" || origin.trim() === "") return null;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** True when `url` is on the bytes host. Always false with `BLOB_ORIGIN` unset. */
export function isBytesHost(url: URL, env: Pick<Env, "BLOB_ORIGIN">): boolean {
  const host = bytesHostname(env);
  return host !== null && url.hostname.toLowerCase() === host;
}

/** Types a bytes-host response may never carry, whatever route produced it. */
const EXECUTABLE_TYPE =
  /html|xml|svg|script|ecmascript|^\s*text\/|multipart\//i;
/** JSON is allowed only as an error body (the platform's `{"error":…}` answers), never as a
 *  success payload: the bytes host serves bytes, not documents. */
const JSON_TYPE = /json/i;

function refusedType(res: Response): boolean {
  const type = res.headers.get("content-type") ?? "";
  if (EXECUTABLE_TYPE.test(type)) return true;
  return JSON_TYPE.test(type) && res.status < 400;
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
 * and any route answer with an executable type, becomes the plain not-found.
 */
export async function dispatchBytesHost(
  req: Request,
  env: Env,
  routes: readonly ByteRoute[] = BYTE_ROUTES,
): Promise<Response> {
  const pathname = new URL(req.url).pathname;
  let res: Response | null = null;
  for (const route of routes) {
    const params = route.match(pathname);
    if (!params) continue;
    res = await route.handle(withoutCookies(req), env, params);
    if (refusedType(res)) {
      console.error("byte route answered with a refused type", {
        route: route.name,
        type: res.headers.get("content-type"),
      });
      await res.body?.cancel().catch(() => undefined);
      res = notFound();
    }
    break;
  }
  // TODO(P0-05): CORS. P0-05's `core/cors.ts` is applied centrally in dispatch; the bytes host
  // must pass through that same step, right here, before hardening. Until P0-05 lands no CORS
  // header is emitted on this host — `test/bytesHost.test.ts` pins both this marker and that
  // absence, so landing P0-05 without wiring this point fails a test.
  return hardenBytesHostResponse(res ?? notFound());
}
