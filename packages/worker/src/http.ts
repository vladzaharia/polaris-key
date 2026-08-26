/// <reference types="@cloudflare/workers-types" />

/** Stable error codes returned to clients (mirrors the SDK error taxonomy). */
export const ErrorCode = {
  Unauthorized: "unauthorized",
  NotEntitled: "not_entitled",
  DeviceLimit: "device_limit",
  BadRequest: "bad_request",
  NotFound: "not_found",
  ManagedByAdmin: "managed_by_admin",
  Forbidden: "forbidden",
  HardwareMismatch: "hardware_mismatch",
  FingerprintRequired: "fingerprint_required",
  EnrollDisabled: "enroll_disabled",
  /** This machine's auto-issued license exists but now belongs to an identity (R3-05). */
  EnrollClaimed: "enroll_claimed",
} as const;

export function json(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export function errorResponse(
  status: number,
  code: string,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  return json(
    { error: code, ...(message ? { message } : {}), ...(extra ?? {}) },
    { status },
  );
}

export function notFound(): Response {
  return errorResponse(404, ErrorCode.NotFound);
}

export function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

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

/** Extract a Bearer credential from the Authorization header. */
export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? (m[1] ?? null) : null;
}
