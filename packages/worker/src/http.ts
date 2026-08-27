/**
 * Request-side HTTP helpers.
 *
 * The error taxonomy and the response builders that used to live here (`ErrorCode`, `json`,
 * `errorResponse`, `notFound`, `methodNotAllowed`) moved to `core/errors.ts` — they are a core
 * capability every service has to reach. What stays is the reading half: parsing a credential
 * out of a request and the two guards that decide whether a request is safe to act on.
 */

/// <reference types="@cloudflare/workers-types" />

/**
 * True for a literal, already-normalised asset path that is safe to assign into
 * `URL.pathname`.
 *
 * The WHATWG URL path parser collapses dot segments — including percent-encoded ones
 * (`%2e%2e`) — so assigning a user-controlled string to `url.pathname` can walk an asset
 * fetch out of its own prefix (R1-06). Rejecting `%` outright means no encoded segment can
 * survive to be normalised, and the explicit `.`/`..` check covers the literal form.
 */
const SAFE_ASSET_PATH = /^\/(?:[A-Za-z0-9_~.-]+\/)*[A-Za-z0-9_~.-]+$/;

export function isSafeAssetPath(path: string): boolean {
  if (!SAFE_ASSET_PATH.test(path)) return false;
  return !path.split("/").some((seg) => seg === "." || seg === "..");
}

/**
 * True when the request looks like a same-origin top-level navigation, per the Fetch Metadata
 * request headers (which are set by the browser and cannot be forged by page script).
 *
 * Used to keep a state-changing `GET` reachable from the app's own UI while refusing the two
 * shapes that make such a route CSRF-able: a cross-site link/redirect
 * (`Sec-Fetch-Site: cross-site`) and a subresource load such as
 * `<img src="https://key.plrs.im/logout">` (`Sec-Fetch-Dest: image`, `Sec-Fetch-Mode: no-cors`).
 *
 * A request carrying NO `Sec-Fetch-Site` at all is allowed: the header's presence is
 * trustworthy, but its absence proves nothing (non-browser clients, pre-2020 browsers).
 * `POST` remains the correct method for a state change — this is a compatibility guard, not a
 * replacement for one.
 */
export function isSameOriginNavigation(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site === null) return true;
  // "none" = the user typed the URL / used a bookmark.
  if (site !== "same-origin" && site !== "none") return false;
  const dest = req.headers.get("sec-fetch-dest");
  if (dest !== null && dest !== "document") return false;
  const mode = req.headers.get("sec-fetch-mode");
  if (mode !== null && mode !== "navigate") return false;
  return true;
}

/**
 * True for the GitHub release-asset storage hosts the SSRF guard permits.
 *
 * ONE definition, because "which hosts may we fetch from" and "which hosts may we redirect a
 * signed-in customer to" are the same question about the same upstream, and answering it twice
 * is how the two drift (R6-12). Two services ask it — Release when it streams an asset, Identity
 * when the portal redeems a `/download/<token>` — and a service may not import a sibling
 * (`test/boundaries.test.ts`), so the predicate lives in the platform layer and both bind to
 * Core's declaration. `services/release/github.ts` re-exports it for its own call sites.
 */
export function isAllowedStorageHost(host: string): boolean {
  return (
    host === "github.com" ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  );
}

/** Extract a Bearer credential from the Authorization header. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? null) : null;
}
