/**
 * The per-product CORS allowlist (P0-05).
 *
 * A browser page served from an origin a product lists under `web.origins` in `.pkey/product`
 * may READ that product's device-facing responses with `fetch`: discovery, JWKS, the trust
 * manifest, the device routes, License, Config, the downloads (Distribution's byte routes),
 * Update and the device-code flow. Every other origin gets no `Access-Control-*` header at all, and so does every surface
 * that is not on the covered list below — the console (`/manage/*`), the portal (`/`, `/api/*`,
 * …), the docs site, the GitHub webhook, and the cookie-bearing or navigation-only identity
 * routes. Those share this origin with the admin cookie (THREAT-MODEL R1-09) and stay
 * first-party.
 *
 * ── WHY A REPO-AUTHORED LIST IS ENOUGH ──────────────────────────────────────────────────────
 *
 * `Access-Control-Allow-Credentials` is NEVER sent, so a listed page's `fetch` carries no
 * cookie and no ambient credential; the bearer tokens these routes take are never ambient
 * either. CORS then decides only which pages may read a response that any non-browser client
 * can already fetch. A `.pkey/` push that adds an origin cannot reach anything a `curl` outside
 * a browser could not, which is why this is a manifest field and not an operator allowlist like
 * `OIDC_ISSUER_ALLOWLIST` (whose value decides where the platform SENDS a secret).
 *
 * ── WHERE IT IS APPLIED, AND WHY THERE ──────────────────────────────────────────────────────
 *
 * In `dispatch.ts`, AFTER the handler returns, never inside one. The release gateway stores
 * handler responses in `caches.default` under a key that does not include the request origin
 * (`services/release/gateway.ts`), so a header added inside a handler would be replayed to every
 * later origin from the cache. Added outside, cached objects stay origin-free and each response
 * is decorated for the request in hand.
 *
 * Preflight (`OPTIONS`) is answered in the same place, before the service registry runs, so its
 * answer is a function of the path SHAPE and the product's list only — never of whether the
 * service behind the path is enabled. Preflight therefore cannot be used to probe enablement.
 */

import { isWebOrigin, MAX_WEB_ORIGINS } from "@polaris-key/manifest";
import {
  HEADER_ARCH,
  HEADER_CHANNEL,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol";
import type { Route } from "../router.js";

/** Every method a covered route answers. `OPTIONS` itself never needs listing. */
export const CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE";

/**
 * The request headers a listed page may send. Named explicitly rather than `*`: the wildcard
 * does not cover `Authorization`, and the explicit list is the documented surface. The
 * `X-PKey-*` spellings come from the protocol constants so a new header cannot be added to the
 * wire without showing up here as a compile-time reference.
 */
export const CORS_ALLOW_HEADERS = [
  "Authorization",
  "Content-Type",
  "Range",
  "If-None-Match",
  "If-Range",
  HEADER_DEVICE,
  HEADER_VERSION,
  HEADER_CHANNEL,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_PLATFORM,
  HEADER_ARCH,
].join(", ");

/**
 * The response headers a listed page may read beyond the CORS-safelisted ones: the ETag a
 * conditional poll replays, and the range headers a resumable download needs. `Repr-Digest` is
 * not sent yet; it is listed now so the change that starts sending it (P2-05 / P2b-04) does not
 * also have to touch CORS.
 */
export const CORS_EXPOSE_HEADERS =
  "ETag, Content-Range, Accept-Ranges, Content-Length, Repr-Digest";

/** Preflight cache lifetime, seconds. Short enough that removing an origin takes effect soon. */
export const CORS_MAX_AGE = "600";

/**
 * The covered service paths, relative to `/<product>/`, in the OpenAPI spelling (`{name}` is one
 * non-empty segment). An INCLUSION list, so a new service route is not browser-readable until
 * someone decides it should be — `test/routeCoverage.test.ts` holds this table, the spec's
 * `options` operations and the router to one another.
 *
 * Deliberately absent (cookie-bearing or navigation-only; they stay first-party):
 * `identity/session`, `identity/session/license`, `identity/auth/start`,
 * `identity/auth/callback`, `identity/auth/logout`, `identity/auth/device`,
 * `identity/auth/device/verify`, `config/mint/{mintId}/auth`, and the CI routes — Release's
 * policy routes (`release/channels/{channel}/{promote,pin,unpin}`,
 * `release/releases/{releaseId}/yank`), its publishing routes and Distribution's rollout routes
 * (`distribution/rollouts/{outlet}/{channel}[/{verb}]`) — which a CI job calls with a `pkeyci_`
 * bearer and no browser page ever should — and the store webhooks
 * (`distribution/hooks/asc`, P5-02), which only the store's servers call.
 *
 * The permanent aliases resolve to the same `{kind:"service"}` route as their targets
 * (`router.ts`), so they are covered exactly when their targets are.
 */
export const CORS_SERVICE_PATHS: readonly string[] = [
  "license/activate",
  "license/enroll",
  "license/token",
  "license/deauthorize",
  "license/document",
  "config/document",
  "config/schema",
  "config/mint/{mintId}/token",
  "release/changelog",
  // P3-03: a CI-signed release record, and (below) the signed channel feed — what a browser SDK
  // fetches and verifies to decide an update.
  "release/records/{sha256}",
  // P2b-04: all byte delivery is Distribution's (P2-05's byte routes and the legacy download and
  // installer, moved). Their `/release/…` and `/<p>/install.sh` spellings are router aliases
  // that resolve to these same routes, so they are covered exactly when these are. (On the bytes
  // host CORS is applied by its own dispatcher.)
  "distribution/install.sh",
  "distribution/dl/{version}/{asset}",
  "distribution/builds/{selector}/{buildId}",
  "distribution/files/{releaseId}/{name}",
  "distribution/blobs/sha256/{sha256}",
  "update/appcast.xml",
  "update/{channel}/appcast.xml",
  "update/{channel}/feed.jws",
  "update/version",
  "identity/auth/poll",
  "identity/auth/device/start",
  "identity/auth/device/poll",
];

/** Core route kinds are all device-facing, and every one of them is covered. */
const CORS_CORE_KINDS: ReadonlySet<Route["kind"]> = new Set<Route["kind"]>([
  "discovery",
  "jwks",
  "trustManifest",
  "devices",
  "report",
  "register",
]);

const SERVICE_TEMPLATES: readonly string[][] = CORS_SERVICE_PATHS.map((p) =>
  p.split("/"),
);

function matchesTemplate(template: string[], segments: string[]): boolean {
  if (template.length !== segments.length) return false;
  return template.every((part, i) => {
    const seg = segments[i]!;
    return part.startsWith("{") ? seg.length > 0 : part === seg;
  });
}

/** Does this route answer CORS at all? Decided from the path shape alone. */
export function isCorsCoveredRoute(route: Route): boolean {
  if (CORS_CORE_KINDS.has(route.kind)) return true;
  if (route.kind !== "service") return false;
  const segments = [route.slug, ...route.rest];
  return SERVICE_TEMPLATES.some((t) => matchesTemplate(t, segments));
}

/** The product's allowlist, from `products.web_origins_json`. */
export interface CorsProduct {
  webOrigins: readonly string[];
}

/**
 * Read `products.web_origins_json`. Fails closed to `[]` on anything unreadable, and re-checks
 * every entry with the manifest's own rule, so a row written by some path other than manifest
 * ingest can never put a wildcard, a path or `null` into `Access-Control-Allow-Origin`.
 */
export function parseWebOrigins(json: string | null | undefined): string[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isWebOrigin))].slice(0, MAX_WEB_ORIGINS);
}

/** The column value for a parsed manifest's list: NULL when nothing was declared. */
export function serializeWebOrigins(origins: readonly string[]): string | null {
  return origins.length > 0 ? JSON.stringify(origins) : null;
}

/** The request's `Origin`, when it is exactly one the product lists. */
function allowedOrigin(product: CorsProduct, req: Request): string | null {
  const origin = req.headers.get("Origin");
  return origin !== null && product.webOrigins.includes(origin) ? origin : null;
}

/** Add `Origin` to `Vary` without disturbing what the handler already varies on. */
function varyOnOrigin(headers: Headers): void {
  const current = headers.get("Vary");
  if (current === null || current.trim() === "") {
    headers.set("Vary", "Origin");
    return;
  }
  const tokens = current.split(",").map((t) => t.trim().toLowerCase());
  if (tokens.includes("*") || tokens.includes("origin")) return;
  headers.set("Vary", `${current}, Origin`);
}

/**
 * Answer `OPTIONS` on a covered path: always 204. The allow set is attached only for a listed
 * origin; any other origin gets a bare 204, which a browser treats as a failed preflight.
 */
export function corsPreflight(product: CorsProduct, req: Request): Response {
  const headers = new Headers();
  if (product.webOrigins.length > 0) headers.set("Vary", "Origin");
  const origin = allowedOrigin(product, req);
  if (origin !== null) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
    headers.set("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    headers.set("Access-Control-Max-Age", CORS_MAX_AGE);
  }
  return new Response(null, { status: 204, headers });
}

/**
 * Decorate a covered route's response for the request in hand. Once a product lists any origin,
 * every covered response carries `Vary: Origin` — allowed origin, other origin or none — so a
 * shared cache can never hand one origin's answer to another. A listed origin additionally gets
 * the allow-origin and expose headers. Any `Access-Control-*` a handler set is dropped first, so
 * this function is the only thing that decides them.
 */
export function withCors(
  product: CorsProduct,
  req: Request,
  res: Response,
): Response {
  if (product.webOrigins.length === 0) return res;
  // A fresh Headers, not an in-place edit: a cache hit or an upstream passthrough carries
  // immutable headers in workerd.
  const headers = new Headers(res.headers);
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
  }
  varyOnOrigin(headers);
  const origin = allowedOrigin(product, req);
  if (origin !== null) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
