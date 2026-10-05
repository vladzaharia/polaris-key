/// <reference types="@cloudflare/workers-types" />
/**
 * Host isolation for the registry host (F-02, plans/F-01.md §6.1).
 *
 * The registry host (`PKG_ORIGIN`, e.g. `https://pkg.plrs.im`) is the same Worker on a third
 * custom domain, beside the console (`key.plrs.im`) and the bytes host (`dl.plrs.im`). It is a
 * line-for-line sibling of `core/bytesHost.ts`: a request that arrives here reaches ONLY the
 * registry routes the composition root lists (`mount.ts` `REGISTRY_ROUTES`), the host's static
 * landing page at `/` and OCI's fixed `/v2/` root. `/manage`, `/docs`, the portal, discovery,
 * the byte routes and every service route answer the plain not-found. Core imports no service
 * (rule 6): the routes, and every feed setting, are Distribution's.
 *
 * WHY THIS IS STRICT (THREAT-MODEL §3, "The registry host and package feeds"): the host is a
 * `*.plrs.im` sibling of the console, so it is SAME-SITE with it. Every compensation of the
 * bytes host is kept unchanged, and the one deliberate widening, the type allowlist below, is
 * reviewed once in the threat model (any change to it is a review trigger, §9):
 *   - every answer carries `X-Content-Type-Options: nosniff`, `REGISTRY_CSP` (`sandbox`, no
 *     sources), `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`;
 *   - no cookie is read (the `Cookie` header is stripped before a route sees the request) and
 *     none is set (`Set-Cookie` is stripped from every answer);
 *   - NO CORS at all: registry clients are not browsers. A route's own `Access-Control-*`
 *     headers are dropped, `core/cors.ts` is never consulted, and `OPTIONS` answers 405;
 *   - a success answer must carry a type on `REGISTRY_HOST_TYPES`; anything else, a missing
 *     type on a body included, is replaced by the not-found. HTML (but for the one admitted
 *     PyPI page), SVG, XML, script and every `text/*` type except `text/x-swift` are refused at
 *     every status. XML documents (POMs, `maven-metadata.xml`) go out as
 *     `application/octet-stream` attachments; `text/x-swift` always leaves as an attachment;
 *   - error answers are the platform's JSON, `application/problem+json` (Swift) or the OCI
 *     error JSON, never HTML, and a throw becomes the JSON 500;
 *   - `GET` and `HEAD`, plus the one `POST` a route declares (`methods`, F-21: Swift's
 *     `POST /swift/<owner>/login`), decided from the path before any owner loads. Any other
 *     method on a registry path is 405, with OCI's error body under `/v2/`.
 *
 * CREDENTIALS (F-21, plans/F-20.md §6.4). The host admits one owner-less route,
 * `GET /v2/token` (OCI's token service, `OwnerlessRegistryRoute`), and `GET /v2/` answers the
 * standard Bearer challenge to a request without a valid pull token once `REGISTRY_TOKEN_KEY`
 * is set (Q1). The pull token's HMAC lives in Core (`registryTokens.ts`), so this file can check
 * it without importing Distribution.
 *
 * SERVICE AND FEED ENABLEMENT. Every registry route names `service: "distribution"`, and the
 * dispatcher refuses a route whose service is off for the owner with the same not-found as an
 * unknown owner. The rest of the ladder (the platform kill switch, the owner's `packageFeeds`,
 * the feed's `enabled` and its access mode) is Distribution's state, so the route runs it
 * through `services/distribution/registry/authorize.ts` `authorizeFeedRead`, BEFORE any cache
 * lookup; a failed check there answers this file's `registryNotFound`, so "off" stays
 * indistinguishable from "absent" across the whole ladder.
 *
 * THE ONE HTML ANSWER ON A ROUTE: the PyPI simple page (PEP 503), for clients that do not ask
 * for PEP 691 JSON. A route flagged `inertDocument` may answer exactly
 * `application/vnd.pypi.simple.v1+html` at 200 (or a body-less 304), with no
 * `Content-Disposition`, under a policy `inertDocumentPolicy` accepts. Nothing else is
 * admitted, and the type is NOT on `REGISTRY_HOST_TYPES`.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { ServiceSlug } from "./services.js";
import { errorResponse, json, notFound } from "./errors.js";
import { inertDocumentPolicy } from "./bytesHost.js";
import { loadProductPublic, type ProductPublic } from "./products.js";
import {
  isRegistryLandingPath,
  registryLandingResponse,
} from "./registryLanding.js";
import {
  buildHooks,
  type DescriptorHooks,
  type ServiceHooks,
} from "./hooks.js";
import {
  registryTokenKeyConfigured,
  verifyPullToken,
} from "./registryTokens.js";

import { registryHostname, registryOrigin } from "./registryHostname.js";

export {
  isRegistryHost,
  registryHostname,
  registryOrigin,
} from "./registryHostname.js";

// ── The closed lists ─────────────────────────────────────────────────────────────────────────

/**
 * Every ecosystem the host knows, as the first path segment (`/<ecosystem>/<owner>/…`), except
 * OCI, whose protocol fixes its root at `/v2/`. A closed list, so a product slug can never
 * shadow an ecosystem: `/<slug>/…` with any other first segment is the plain not-found.
 */
export const REGISTRY_ECOSYSTEMS = [
  "npm",
  "pypi",
  "swift",
  "maven",
  "godot",
  "oci",
  "cargo",
  "go",
  "nuget",
] as const;
export type RegistryEcosystem = (typeof REGISTRY_ECOSYSTEMS)[number];

/** Reserved for tier 3 (F-30, F-32): known names, no routes, so always the not-found. (F-31's
 *  `go` has its feed.) */
export const RESERVED_ECOSYSTEMS: ReadonlySet<RegistryEcosystem> = new Set([
  "cargo",
  "nuget",
]);

export function isRegistryEcosystem(v: unknown): v is RegistryEcosystem {
  return (
    typeof v === "string" &&
    (REGISTRY_ECOSYSTEMS as readonly string[]).includes(v)
  );
}

/** The ecosystem a path belongs to: `oci` for `/v2` and below, else its first segment when that
 *  is a known ecosystem other than `oci`; `null` for every other path. */
export function registryEcosystemOf(
  pathname: string,
): RegistryEcosystem | null {
  if (pathname === "/v2" || pathname.startsWith("/v2/")) return "oci";
  const first = /^\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  if (first === undefined || first === "oci") return null;
  return isRegistryEcosystem(first) ? first : null;
}

/** The policy every registry-host answer carries, except an admitted inert document. The same
 *  value as `BLOB_CSP`: an opaque origin, no script, no sources, no framing. */
export const REGISTRY_CSP =
  "sandbox; default-src 'none'; frame-ancestors 'none'";

/**
 * The types a registry route may answer with (plans/F-01.md §6.1), the host's ONE deliberate
 * widening over `BYTES_HOST_TYPES`: registry JSON, `text/x-swift` (SwiftPM's `Package.swift`),
 * PNG and JPEG (Godot icons) and the archive types. Never add `xml` or `text/html` here: XML
 * goes out as `application/octet-stream`, and the PyPI HTML page is admitted by the
 * `inertDocument` rule alone. `test/registryHost.test.ts` pins that every entry stays inert.
 * Any change to this list is a THREAT-MODEL §9 review trigger.
 */
export const REGISTRY_HOST_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/vnd.npm.install-v1+json",
  "application/vnd.pypi.simple.v1+json",
  "application/vnd.swift.registry.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "text/x-swift",
  "image/png",
  "image/jpeg",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
]);

/** The PyPI simple page's type (PEP 691's HTML spelling): the one HTML answer a route may give. */
export const PYPI_HTML_TYPE = "application/vnd.pypi.simple.v1+html";

/** Refused at every status, whatever the allowlist says: anything a browser may execute or
 *  render as an active document. `text/x-swift` is the one `text/*` exception. */
const NEVER_SERVED = /html|xml|svg|script|ecmascript|multipart\//i;
const TEXT_TYPE = /^\s*text\//i;
const SWIFT_SOURCE = "text/x-swift";

/** The error bodies a route may answer with at 400 and above. */
const ERROR_JSON_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/problem+json",
]);

/** Types that always leave as `attachment` (archives, opaque bytes and Swift source). */
const ATTACHMENT_TYPES: ReadonlySet<string> = new Set([
  "text/x-swift",
  "application/zip",
  "application/gzip",
  "application/x-tar",
  "application/octet-stream",
]);

function baseType(t: string): string {
  return (t.split(";")[0] ?? "").trim().toLowerCase();
}

// ── Routes ───────────────────────────────────────────────────────────────────────────────────

/** What a registry route's `match` returns: the owner (a product slug) and its parameters. */
export interface RegistryRouteMatch {
  readonly owner: string;
  readonly params: Record<string, string>;
}

/** What a registry route's handler receives once its owner has loaded and passed the
 *  dispatcher's service check. */
export interface RegistryRouteContext {
  readonly env: Env;
  readonly db: Db;
  /** The owner WITHOUT its signing key: no registry route signs anything. */
  readonly product: ProductPublic;
  readonly ecosystem: RegistryEcosystem;
  readonly params: Record<string, string>;
  readonly now: number;
  /** The read-only descriptor hooks, gated on the owner's enablement (`core/hooks.ts`). */
  readonly hooks: ServiceHooks;
  /** Finish work after answering (a render-on-miss write-back); absent in Node tests. */
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * The mark `feedRoute` (`services/distribution/registry/serve.ts`) puts on every route it builds.
 * A route so marked answers a read only through `serveFeedRead`, the access ladder (`authorize`
 * then cache). `test/registryHost.test.ts` requires it on every `REGISTRY_ROUTES` entry, so no
 * registry route can skip the ladder.
 */
export const FEED_READ_ROUTE: unique symbol = Symbol.for(
  "polaris-key.registry.feedRead",
) as never;

/**
 * The mark Distribution's credential routes carry (F-21: Swift's `POST …/login`). Such a route
 * reads no package: it only says whether a presented token is valid for its owner. The
 * structural test admits exactly these, beside the feed-read routes, in `REGISTRY_ROUTES`.
 */
export const FEED_AUTH_ROUTE: unique symbol = Symbol.for(
  "polaris-key.registry.feedAuth",
) as never;

/** One route that may answer on the registry host. */
export interface RegistryRoute {
  /** Set by `feedRoute` only (see {@link FEED_READ_ROUTE}). */
  readonly [FEED_READ_ROUTE]?: true;
  /** Set by Distribution's credential routes only (see {@link FEED_AUTH_ROUTE}). */
  readonly [FEED_AUTH_ROUTE]?: true;
  /** The methods beyond GET and HEAD the route answers (F-21: Swift's login `POST`). A route
   *  that declares methods answers only those. */
  readonly methods?: readonly "POST"[];
  /** For logs, tests and `routeCoverage`'s `REGISTRY_PATHS`. */
  readonly name: string;
  /** Every registry route is Distribution's; with it off for the owner the route never runs. */
  readonly service: ServiceSlug;
  /** The ecosystem whose paths it serves. The dispatcher consults it only for those paths. */
  readonly ecosystem: RegistryEcosystem;
  /** F-05's PyPI simple route only: may answer the inert `PYPI_HTML_TYPE` document. */
  readonly inertDocument?: true;
  /** The owner and parameters when the route handles `pathname`, else `null`. */
  match(pathname: string): RegistryRouteMatch | null;
  handle(req: Request, ctx: RegistryRouteContext): Promise<Response>;
}

/** What an owner-less route's handler receives: no owner, a way to load one. */
export interface OwnerlessRouteContext {
  readonly env: Env;
  readonly db: Db;
  readonly now: number;
  /** An owner's route context, as the dispatcher builds it for an owned route: `null` for an
   *  unknown owner or one whose Distribution is off (the same not-found either way). */
  ownerContext(
    owner: string,
    ecosystem: RegistryEcosystem,
    params?: Record<string, string>,
  ): Promise<RegistryRouteContext | null>;
  readonly waitUntil?: (p: Promise<unknown>) => void;
}

/**
 * A route with no owner in its path (F-21: OCI's `GET /v2/token`, whose scopes name the owners).
 * GET and HEAD only. Its handler loads each owner it needs through `ownerContext`.
 */
export interface OwnerlessRegistryRoute {
  readonly ownerless: true;
  readonly name: string;
  readonly ecosystem: RegistryEcosystem;
  matches(pathname: string): boolean;
  handle(req: Request, ctx: OwnerlessRouteContext): Promise<Response>;
}

/** The registry, as far as building hooks needs it (structural, so Core imports no service). */
export type RegistryHookRegistry = ReadonlyMap<
  ServiceSlug,
  { slug: ServiceSlug } & DescriptorHooks
>;

// ── Fixed answers ────────────────────────────────────────────────────────────────────────────

/**
 * The not-found every refusal on the host answers, per ecosystem: OCI's error JSON
 * (`NAME_UNKNOWN`), Swift's `problem+json`, and the platform's flat JSON for the rest. An
 * unknown owner, a disabled service, a disabled feed and a missing object all answer this, so
 * none can be told apart. `no-store`: a not-found is never cached.
 */
export function registryNotFound(
  ecosystem: RegistryEcosystem | null,
): Response {
  if (ecosystem === "oci")
    return json(
      {
        errors: [
          {
            code: "NAME_UNKNOWN",
            message: "repository name not known to registry",
          },
        ],
      },
      // F-08: every answer under `/v2/` names the distribution API version.
      {
        status: 404,
        headers: { "docker-distribution-api-version": "registry/2.0" },
      },
    );
  if (ecosystem === "swift")
    return json(
      { detail: "not found" },
      { status: 404, headers: SWIFT_PROBLEM_HEADERS },
    );
  return notFound();
}

/** Swift's problem answers carry `Content-Version: 1` like every Swift answer (F-06,
 *  `Registry.md` §3.3 and §3.5). */
const SWIFT_PROBLEM_HEADERS = {
  "content-type": "application/problem+json",
  "content-version": "1",
} as const;

/** 405 for a method a registry path does not answer (OCI's error JSON under `/v2/`, Swift's
 *  `problem+json` under `/swift/`). */
export function registryMethodNotAllowed(
  ecosystem: RegistryEcosystem | null,
): Response {
  const allow = { allow: "GET, HEAD" };
  if (ecosystem === "swift") {
    return json(
      { detail: "method not allowed" },
      { status: 405, headers: { ...SWIFT_PROBLEM_HEADERS, ...allow } },
    );
  }
  if (ecosystem === "oci")
    return json(
      {
        errors: [
          { code: "UNSUPPORTED", message: "The operation is unsupported." },
        ],
      },
      {
        status: 405,
        headers: {
          ...allow,
          "docker-distribution-api-version": "registry/2.0",
        },
      },
    );
  const res = errorResponse(405, "method_not_allowed");
  res.headers.set("allow", allow.allow);
  return res;
}

/**
 * OCI's base endpoint (`GET /v2/`, distribution-spec "end-1"). Before `REGISTRY_TOKEN_KEY` is
 * set: 200 and `Docker-Distribution-API-Version: registry/2.0` for everyone. Once it is set (Q1,
 * plans/F-20.md §6.4): 200 only to a request bearing a valid pull token, else the standard 401
 * Bearer challenge naming `/v2/token`, as Docker Hub and GHCR answer. Anonymous pull tokens keep
 * public pulls working, and `docker login` then checks its credentials at once. Owner-less and
 * the same for everyone, so it discloses nothing.
 */
async function ociBase(req: Request, env: Env): Promise<Response> {
  const headers = {
    "content-type": "application/json",
    "docker-distribution-api-version": "registry/2.0",
    "cache-control": "no-store",
  };
  if (registryTokenKeyConfigured(env)) {
    const auth = req.headers.get("authorization") ?? "";
    const m = /^bearer\s+(\S+)\s*$/i.exec(auth);
    const claims = m
      ? await verifyPullToken(env, m[1]!, Math.floor(Date.now() / 1000))
      : null;
    if (!claims) {
      const host = registryHostname(env) ?? "pkg.plrs.im";
      const origin = registryOrigin(env) ?? `https://${host}`;
      return new Response(
        req.method === "HEAD"
          ? null
          : JSON.stringify({
              errors: [
                { code: "UNAUTHORIZED", message: "authentication required" },
              ],
            }),
        {
          status: 401,
          headers: {
            ...headers,
            "www-authenticate": `Bearer realm="${origin}/v2/token",service="${host}"`,
          },
        },
      );
    }
  }
  return new Response(req.method === "HEAD" ? null : "{}", {
    status: 200,
    headers,
  });
}

// ── The host's rules ─────────────────────────────────────────────────────────────────────────

/**
 * The checked policy of an admitted PyPI HTML page, or `null` when the answer is not one: a 200
 * (or body-less 304) of exactly `PYPI_HTML_TYPE` (an optional `charset=utf-8`), with no
 * `Content-Disposition`, under an inert policy.
 */
function pypiDocumentPolicy(res: Response): string | null {
  if (res.status !== 200 && res.status !== 304) return null;
  if (res.status === 304 && res.body !== null) return null;
  const raw = (res.headers.get("content-type") ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (
    res.status === 200 &&
    raw !== PYPI_HTML_TYPE &&
    raw !== `${PYPI_HTML_TYPE};charset=utf-8`
  )
    return null;
  if (res.headers.has("content-disposition")) return null;
  const csp = res.headers.get("content-security-policy");
  return inertDocumentPolicy(csp) ? csp : null;
}

/**
 * The host-wide type rule, applied to every route answer:
 *   - HTML, XML, SVG, script, `multipart/*` and every `text/*` but `text/x-swift` are refused
 *     at every status;
 *   - below 400, a type must be on `REGISTRY_HOST_TYPES`, and a body must have one;
 *   - at 400 and above, a body's type must be a JSON error type or allowlisted.
 * A body-less answer with no type (304, a HEAD-style 200) passes.
 */
export function refusedRegistryType(res: Response): boolean {
  const raw = res.headers.get("content-type");
  const type = raw === null ? "" : baseType(raw);
  if (raw !== null && NEVER_SERVED.test(raw)) return true;
  if (raw !== null && TEXT_TYPE.test(raw) && type !== SWIFT_SOURCE) return true;
  if (type === "") return res.body !== null;
  if (REGISTRY_HOST_TYPES.has(type)) return false;
  return !(res.status >= 400 && ERROR_JSON_TYPES.has(type));
}

/** The answer without a route's own `Access-Control-*` headers, and with `attachment` forced on
 *  archive, opaque and Swift-source successes (keeping a filename the route gave). */
function policed(res: Response): Response {
  const headers = new Headers();
  let touched = false;
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("access-control-")) touched = true;
    else headers.append(key, value);
  });
  const type = baseType(res.headers.get("content-type") ?? "");
  if (res.status < 400 && ATTACHMENT_TYPES.has(type)) {
    const disp = res.headers.get("content-disposition") ?? "";
    if (!/^\s*attachment\s*(;|$)/i.test(disp)) {
      const params = /^\s*inline\s*;(.*)$/i.exec(disp)?.[1];
      headers.set(
        "content-disposition",
        params !== undefined ? `attachment;${params}` : "attachment",
      );
      touched = true;
    }
  }
  if (!touched) return res;
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * The headers every registry-host answer leaves with, not-found answers included: no
 * `Set-Cookie`, no `Access-Control-*`, `nosniff`, the sandbox policy (or an admitted
 * document's own checked one), `no-referrer` and `same-origin` resource policy.
 */
export function hardenRegistryHostResponse(
  res: Response,
  documentCsp: string | null = null,
): Response {
  const headers = new Headers();
  res.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k !== "set-cookie" && !k.startsWith("access-control-"))
      headers.append(key, value);
  });
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", documentCsp ?? REGISTRY_CSP);
  headers.set("referrer-policy", "no-referrer");
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** The request a registry route sees: identical, minus any `Cookie` header. */
function withoutCookies(req: Request): Request {
  if (!req.headers.has("cookie")) return req;
  const headers = new Headers(req.headers);
  headers.delete("cookie");
  return new Request(req, { headers });
}

/** The slice of the runtime's `ExecutionContext` the host uses. */
export interface RegistryExecution {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Dispatch a request that arrived on the registry host. Only `routes` and `ownerless` can answer
 * (`dispatch.ts` passes `mount.ts`'s `REGISTRY_ROUTES` and `REGISTRY_OWNERLESS_ROUTES`), plus `/`
 * and `/v2/`; anything else, an
 * unknown owner, a route whose service is off for the owner, and any answer whose type breaks
 * the host's rule, becomes the not-found. Every answer is hardened, a throw included.
 */
export async function dispatchRegistryHost(
  req: Request,
  env: Env,
  db: Db,
  routes: readonly RegistryRoute[],
  registry: RegistryHookRegistry = new Map(),
  exec?: RegistryExecution,
  ownerless: readonly OwnerlessRegistryRoute[] = [],
): Promise<Response> {
  let answered: Answer;
  try {
    answered = await answer(req, env, db, routes, registry, exec, ownerless);
  } catch {
    // As on the bytes host (P2-05): a throw would otherwise become Cloudflare's own HTML error
    // page, without `nosniff` or the sandbox. Nothing about the failure is disclosed (R12).
    answered = { res: errorResponse(500, "internal_error"), documentCsp: null };
  }
  return hardenRegistryHostResponse(answered.res, answered.documentCsp);
}

interface Answer {
  res: Response;
  documentCsp: string | null;
}

async function answer(
  req: Request,
  env: Env,
  db: Db,
  routes: readonly RegistryRoute[],
  registry: RegistryHookRegistry,
  exec: RegistryExecution | undefined,
  ownerless: readonly OwnerlessRegistryRoute[],
): Promise<Answer> {
  const plain = (res: Response): Answer => ({ res, documentCsp: null });
  const pathname = new URL(req.url).pathname;
  const readOnly = req.method === "GET" || req.method === "HEAD";

  // The landing page (`registryLanding.ts`): exactly `/`, GET or HEAD, admitted only under the
  // inert-document check, as on the bytes host.
  if (isRegistryLandingPath(pathname)) {
    if (req.method === "OPTIONS") return plain(registryMethodNotAllowed(null));
    if (!readOnly) return plain(notFound());
    const res = await registryLandingResponse(req, env);
    const csp = res.headers.get("content-security-policy");
    if (
      res.headers.get("content-type") === "text/html; charset=utf-8" &&
      inertDocumentPolicy(csp)
    )
      return { res, documentCsp: csp };
    await res.body?.cancel().catch(() => undefined);
    return plain(notFound());
  }

  const ecosystem = registryEcosystemOf(pathname);
  if (ecosystem === null) {
    // Not a registry path. No preflight is ever answered on this host; everything else is the
    // plain not-found the bytes host gives a console path.
    return plain(
      req.method === "OPTIONS" ? registryMethodNotAllowed(null) : notFound(),
    );
  }
  // GET and HEAD, plus a method a route of this ecosystem declares and whose path it matches
  // (Swift's login `POST`), decided from the path alone (the lists are public), before any owner
  // is loaded, so a 405 can never probe an owner.
  const declared = readOnly
    ? null
    : routes.find(
        (r) =>
          r.ecosystem === ecosystem &&
          (r.methods as readonly string[] | undefined)?.includes(req.method) &&
          r.match(pathname) !== null,
      );
  if (!readOnly && !declared) return plain(registryMethodNotAllowed(ecosystem));
  if (ecosystem === "oci" && (pathname === "/v2" || pathname === "/v2/"))
    return plain(await ociBase(req, env));
  if (RESERVED_ECOSYSTEMS.has(ecosystem))
    return plain(registryNotFound(ecosystem));

  const waitUntil = exec
    ? { waitUntil: (p: Promise<unknown>) => exec.waitUntil(p) }
    : {};
  /** An owner's context: `null` for an unknown owner or a service that is off for it. */
  const ownerContext = async (
    owner: string,
    eco: RegistryEcosystem,
    service: ServiceSlug,
    params: Record<string, string>,
  ): Promise<RegistryRouteContext | null> => {
    const product = await loadProductPublic(db, owner);
    if (!product) return null;
    // `dispatchService`'s rule: a service off for the owner never runs a line of its code, and
    // answers the same not-found as an unknown owner.
    if (!product.services[service]?.enabled) return null;
    const now = Math.floor(Date.now() / 1000);
    return {
      env,
      db,
      product,
      ecosystem: eco,
      params,
      now,
      hooks: buildHooks(registry, product.services, { env, db, product, now }),
      ...waitUntil,
    };
  };

  if (readOnly)
    for (const route of ownerless) {
      if (route.ecosystem !== ecosystem || !route.matches(pathname)) continue;
      const res = await route.handle(withoutCookies(req), {
        env,
        db,
        now: Math.floor(Date.now() / 1000),
        ownerContext: (owner, eco, params = {}) =>
          ownerContext(owner, eco, "distribution", params),
        ...waitUntil,
      });
      if (refusedRegistryType(res)) {
        await res.body?.cancel().catch(() => undefined);
        return plain(registryNotFound(ecosystem));
      }
      return plain(policed(res));
    }

  for (const route of declared ? [declared] : routes) {
    if (route.ecosystem !== ecosystem) continue;
    // A route that declares methods answers only those; a read route never answers a POST.
    if (readOnly && route.methods !== undefined) continue;
    const matched = route.match(pathname);
    if (!matched) continue;
    const ctx = await ownerContext(
      matched.owner,
      ecosystem,
      route.service,
      matched.params,
    );
    if (!ctx) return plain(registryNotFound(ecosystem));
    const res = await route.handle(withoutCookies(req), ctx);
    if (route.inertDocument) {
      const csp = pypiDocumentPolicy(res);
      if (csp !== null) return { res: policed(res), documentCsp: csp };
    }
    if (refusedRegistryType(res)) {
      // Replaced silently (R12): indistinguishable from a route that does not exist.
      await res.body?.cancel().catch(() => undefined);
      return plain(registryNotFound(ecosystem));
    }
    return plain(policed(res));
  }
  return plain(registryNotFound(ecosystem));
}
