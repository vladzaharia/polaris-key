/// <reference types="@cloudflare/workers-types" />
/**
 * Host isolation for the bytes host (P2-01).
 *
 * The bytes host (`BLOB_ORIGIN`, e.g. `https://dl.plrs.im`) is the same Worker on a second
 * custom domain. A request that arrives there reaches ONLY the byte routes the composition root
 * lists (`mount.ts` `BYTE_ROUTES`); everything else — `/manage`, `/docs`, the portal, discovery,
 * every service route — answers the ordinary not-found. P2-05 and P2b-04 add the first byte
 * routes; P2-01 adds none.
 *
 * SERVICE ENABLEMENT: the bytes host does not go through `dispatchService`
 * (`core/registry.ts`), so it makes that function's enablement check itself. Every byte route
 * names the service it belongs to, and a route whose service is off for the product never runs:
 * it answers the same not-found as an unknown product or an unmatched path, so "off" is
 * indistinguishable from "absent" here too. A product that disables Release (or
 * Distribution) therefore stops serving bytes on `dl.plrs.im` the moment it does, exactly as
 * its paths on the console stop answering.
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
 *
 * ONE HTML ANSWER OUTSIDE THE ROUTES: `GET /` (and `HEAD /`) is the host's static landing page
 * (`bytesLanding.ts`, BRAND §8). It is admitted through the same inert-document check as a
 * `document` route (`documentPolicy`), so it carries a `sandbox` policy with no script source,
 * and every header rule above applies to it unchanged.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { ServiceSlug } from "../services.js";
import { errorResponse, notFound } from "../errors.js";
import { BLOB_CSP, BYTES_HOST_TYPES } from "./blobs.js";
import { corsPreflight, withCors } from "../cors.js";
import { loadProductPublic, type ProductPublic } from "../products.js";
import { isLandingPath, landingResponse } from "./bytesLanding.js";
import { hostedImageOrigin } from "./hostedImages.js";
import { cspImageOrigin } from "../../platform/securityHeaders.js";
import {
  buildHooks,
  type DescriptorHooks,
  type ServiceHooks,
} from "../hooks.js";

/**
 * What a byte route's `match` returns: the product that owns the path, plus its parameters.
 * Every byte route is product-scoped — a key is served only when THIS product holds a ref to
 * it (`blobs.ts` `hasRef`) — and the product is also what decides CORS (`core/cors.ts`).
 */
export interface ByteRouteMatch {
  readonly product: string;
  readonly params: Record<string, string>;
}

/**
 * What a byte route's handler receives once its product has loaded.
 *
 * `product` is a `ProductPublic`: the product WITHOUT its signing key (P2-05, least
 * privilege). No byte route signs anything, so the dispatcher never unseals the key under
 * `PLATFORM_KEK` on a download, and no route here can be handed it.
 */
export interface ByteRouteContext {
  readonly env: Env;
  readonly db: Db;
  readonly product: ProductPublic;
  readonly params: Record<string, string>;
  readonly now: number;
  /**
   * The read-only descriptor hooks (`core/hooks.ts`) for this product, gated on ITS enablement
   * exactly as `dispatchService` gates them on the console (P2b-04: Distribution's byte routes
   * read Release's catalog and their own delivery access through these).
   */
  readonly hooks: ServiceHooks;
}

/** The registry, as far as building hooks needs it (structural, so Core imports no service). */
export type ByteHookRegistry = ReadonlyMap<
  ServiceSlug,
  { slug: ServiceSlug } & DescriptorHooks
>;

/** One route that may answer on the bytes host. */
export interface ByteRoute {
  /** For logs and tests. */
  readonly name: string;
  /**
   * The service this route belongs to. The dispatcher runs the route only while that service is
   * enabled for the matched product (the check `dispatchService` makes on the console); with it
   * off the route's code never runs and the host answers not-found.
   */
  readonly service: ServiceSlug;
  /**
   * P2b-06. The route answers ONE server-rendered HTML document (the public download page)
   * rather than bytes. The host's type rule then admits exactly one more success type,
   * `text/html; charset=utf-8`, and only with the route's own `Content-Security-Policy`, which
   * the dispatcher CHECKS (`inertDocumentPolicy`) and refuses unless it keeps the host's
   * guarantees: a `sandbox` without `allow-scripts` or `allow-same-origin` (an opaque origin,
   * no script), `default-src 'none'`, nothing but hashed styles, no framing, no base, no forms.
   * A document route answers no CORS (it is a navigation, never a fetch target) and no
   * `OPTIONS`; its error answers follow the ordinary rule.
   */
  readonly document?: true;
  /** The owning product and path parameters when the route handles `pathname`, else `null`. */
  match(pathname: string): ByteRouteMatch | null;
  handle(req: Request, ctx: ByteRouteContext): Promise<Response>;
}

export { bytesHostname, isBytesHost } from "./bytesHostname.js";

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

/** The sandbox tokens a document's policy may keep: each lets a CLICK do something (download a
 *  file, open an app link); none runs script, lifts the opaque origin or submits a form. */
const DOCUMENT_SANDBOX_TOKENS: ReadonlySet<string> = new Set([
  "allow-downloads",
  "allow-top-navigation-to-custom-protocols",
]);
const HASH_SOURCE = /^'sha256-[A-Za-z0-9+/]{43}='$/;

/** What a document policy may name beyond the fixed rule (`inertDocumentPolicy`). */
export interface DocumentPolicyOptions {
  /**
   * The image host's origin (HA-07: the download page shows the product's hosted icon). `img-src`
   * may then name exactly it, beside `data:`. Written only once `cspImageOrigin` accepts it (a
   * bare https origin); `null`, absent or anything else admits `data:` alone, as before.
   */
  imgOrigin?: string | null;
}

/**
 * Is `csp` a policy under which an HTML document on this host stays inert? Every directive must
 * be one of these, spelled this way, and the first four must be present:
 *
 *   sandbox [allow-downloads] [allow-top-navigation-to-custom-protocols]
 *   default-src 'none'          frame-ancestors 'none'          base-uri 'none'
 *   form-action 'none'          style-src 'sha256-…'…           img-src [data:] [<image host>]
 *
 * `img-src` names `data:`, the image host's origin (`opts.imgOrigin`, HA-07) or both, each at most
 * once. The image host serves only public raster images under its own sandbox policy, and an
 * image runs nothing in a sandboxed, script-free document. Anything else — a script source of any
 * kind, `connect-src`, `allow-scripts`, any other image source, a second policy joined by a comma,
 * a repeated directive — and the answer is refused.
 */
export function inertDocumentPolicy(
  csp: string | null,
  opts: DocumentPolicyOptions = {},
): boolean {
  const imageHost = cspImageOrigin(opts.imgOrigin);
  if (csp === null || csp.includes(",")) return false;
  const seen = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0]!.toLowerCase();
    if (seen.has(name)) return false;
    seen.set(name, tokens.slice(1));
  }
  const exactlyNone = (name: string) => {
    const v = seen.get(name);
    return v !== undefined && v.length === 1 && v[0] === "'none'";
  };
  for (const [name, values] of seen) {
    switch (name) {
      case "sandbox":
        if (!values.every((t) => DOCUMENT_SANDBOX_TOKENS.has(t))) return false;
        break;
      case "default-src":
      case "frame-ancestors":
      case "base-uri":
      case "form-action":
        if (!exactlyNone(name)) return false;
        break;
      case "style-src":
        if (!values.length || !values.every((t) => HASH_SOURCE.test(t)))
          return false;
        break;
      case "img-src":
        if (
          !values.length ||
          new Set(values).size !== values.length ||
          !values.every(
            (v) => v === "data:" || (imageHost !== null && v === imageHost),
          )
        )
          return false;
        break;
      default:
        return false;
    }
  }
  return (
    seen.has("sandbox") &&
    seen.has("default-src") &&
    seen.has("frame-ancestors") &&
    seen.has("base-uri") &&
    seen.has("form-action")
  );
}

/**
 * The policy a document route's answer leaves with, or `null` = refused (`document` on
 * `ByteRoute`). Only a 200 (or a body-less 304) of exactly `text/html; charset=utf-8`, with no
 * `Content-Disposition`, under an inert policy.
 */
async function documentPolicy(
  res: Response,
  env: Env,
  db: Db,
): Promise<string | null> {
  if (res.status !== 200 && res.status !== 304) return null;
  if (res.status === 304 && res.body !== null) return null;
  const type = (res.headers.get("content-type") ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (res.status === 200 && type !== "text/html;charset=utf-8") return null;
  if (res.headers.has("content-disposition")) return null;
  const csp = res.headers.get("content-security-policy");
  // HA-07: the image host may be an image source, only while hosted copies are served.
  return inertDocumentPolicy(csp, {
    imgOrigin: await hostedImageOrigin(env, db),
  })
    ? csp
    : null;
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
export function hardenBytesHostResponse(
  res: Response,
  documentCsp: string | null = null,
): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  headers.set("x-content-type-options", "nosniff");
  // A checked document policy (`documentPolicy`) is itself a sandbox; everything else gets the
  // host's own.
  headers.set("content-security-policy", documentCsp ?? BLOB_CSP);
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
 * Dispatch a request that arrived on the bytes host. Only `routes` can answer (`dispatch.ts`
 * passes `mount.ts`'s `BYTE_ROUTES`, and the service registry the routes' hooks are built from);
 * anything else, an unknown product, a route whose service is disabled for that product, and any
 * route answer whose type breaks the host's rule (`refusedType`), becomes the plain not-found.
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
  routes: readonly ByteRoute[],
  registry: ByteHookRegistry = new Map(),
): Promise<Response> {
  let answered: Answer;
  try {
    answered = await answer(req, env, db, routes, registry);
  } catch {
    // P2-05. A throw from a route, from the product load or from D1 would otherwise escape the
    // Worker and become Cloudflare's own HTML error page — on this host, without `nosniff` or
    // the sandbox CSP. Answer the platform's flat JSON 500 instead, hardened like everything
    // else here. Nothing about the failure is disclosed (R12: the worker logs no request data).
    answered = { res: errorResponse(500, "internal_error"), documentCsp: null };
  }
  return hardenBytesHostResponse(answered.res, answered.documentCsp);
}

/** A route's policed answer, and the checked policy when it is an admitted document. */
interface Answer {
  res: Response;
  documentCsp: string | null;
}

async function answer(
  req: Request,
  env: Env,
  db: Db,
  routes: readonly ByteRoute[],
  registry: ByteHookRegistry,
): Promise<Answer> {
  const plain = (res: Response): Answer => ({ res, documentCsp: null });
  const pathname = new URL(req.url).pathname;
  // The host's landing page (BRAND §8, `bytesLanding.ts`): exactly `/`, GET or HEAD. A static
  // document admitted only under the same inert-document check as a `document` route; any other
  // method on `/` keeps the plain not-found, and no other path can reach it.
  if (isLandingPath(pathname)) {
    if (req.method !== "GET" && req.method !== "HEAD") return plain(notFound());
    const res = await landingResponse(req, env);
    const csp = await documentPolicy(res, env, db);
    if (csp !== null) return { res, documentCsp: csp };
    await res.body?.cancel().catch(() => undefined);
    return plain(notFound());
  }
  for (const route of routes) {
    const matched = route.match(pathname);
    if (!matched) continue;
    // The key-free loader: a download never needs the product's signing key (P2-05).
    const product = await loadProductPublic(db, matched.product);
    if (!product) return plain(notFound());
    if (route.document)
      return answerDocument(req, env, db, route, matched, product, registry);
    // Preflight first, as `dispatch.ts` does for the console: its answer depends only on the
    // path shape and the product's `web.origins`, so it cannot probe enablement.
    if (req.method === "OPTIONS") return plain(corsPreflight(product, req));
    // Enablement next, before any route code runs (`dispatchService`'s rule). Same not-found
    // as an unknown product, so a disabled service cannot be told apart from a missing one.
    if (!product.services[route.service]?.enabled) return plain(notFound());
    const now = Math.floor(Date.now() / 1000);
    let res = await route.handle(withoutCookies(req), {
      env,
      db,
      product,
      params: matched.params,
      now,
      hooks: buildHooks(registry, product.services, { env, db, product, now }),
    });
    // A refused type is replaced silently: the worker logs nothing (R12), and the not-found
    // answer is indistinguishable from a route that does not exist.
    if (refusedType(res)) {
      await res.body?.cancel().catch(() => undefined);
      res = notFound();
    }
    return plain(withCors(product, req, policed(res)));
  }
  return plain(notFound());
}

/**
 * A `document` route (P2b-06): enablement as for every route, no CORS and no preflight, and the
 * answer admitted only as an inert document (`documentPolicy`) or as an ordinary error answer
 * (`refusedType`); anything else is the plain not-found.
 */
async function answerDocument(
  req: Request,
  env: Env,
  db: Db,
  route: ByteRoute,
  matched: ByteRouteMatch,
  product: ProductPublic,
  registry: ByteHookRegistry,
): Promise<Answer> {
  if (!product.services[route.service]?.enabled)
    return { res: notFound(), documentCsp: null };
  const now = Math.floor(Date.now() / 1000);
  const res = await route.handle(withoutCookies(req), {
    env,
    db,
    product,
    params: matched.params,
    now,
    hooks: buildHooks(registry, product.services, { env, db, product, now }),
  });
  const csp = res.status < 400 ? await documentPolicy(res, env, db) : null;
  if (csp !== null) return { res: stripCors(res), documentCsp: csp };
  if (res.status >= 400 && !refusedType(res))
    return { res: stripCors(res), documentCsp: null };
  await res.body?.cancel().catch(() => undefined);
  return { res: notFound(), documentCsp: null };
}

/** A route's own `Access-Control-*` headers dropped (CORS is `core/cors.ts`'s alone). */
function stripCors(res: Response): Response {
  let touched = false;
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("access-control-")) touched = true;
    else headers.append(key, value);
  });
  return touched
    ? new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      })
    : res;
}
