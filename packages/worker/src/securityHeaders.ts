/**
 * Response security headers for every surface the worker serves.
 *
 * Threat model (R1-09): the admin cookie is scoped to this origin, so **any** same-origin
 * script execution is a full control-plane takeover — `HttpOnly` + `SameSite` + the CSRF
 * double-submit are all bypassed by a script the browser considers same-origin, because
 * `/manage/api/me` hands out the CSRF token to anything that can fetch with credentials.
 * The mitigation is therefore that NO html response on this origin may ship without a CSP.
 *
 * Two policies:
 *   - `appSecurityHeaders` — the SPA shells and the JSON APIs. `script-src 'self'` because
 *     the SPA loads its own bundle, plus the SHA-256 of the shells' one inline script (the
 *     pre-paint theme script, `adminCsp.ts`); never `'unsafe-inline'`.
 *   - `staticHtmlSecurityHeaders` — every server-rendered interstitial (sign-in errors, the
 *     device-authorization page, the "you're signed in" page, the edge-mint auth page).
 *     These pages have no scripts at all, so `default-src 'none'` is achievable: an injected
 *     `<script>` cannot execute and an injected `fetch()` cannot reach `/manage/api/*`.
 *     Inline *styles* are allowed because these pages are styled with `style=` attributes;
 *     with `default-src 'none'` the worst a CSS injection can do is load an image from
 *     `'self'`.
 */

import { ADMIN_SCRIPT_HASHES } from "./adminCsp.js";

/**
 * SPA + JSON policy: the admin/portal bundles execute their own scripts, plus the shells' one
 * inline pre-paint theme script, allowed by its hash.
 */
const APP_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src ${["'self'", ...ADMIN_SCRIPT_HASHES].join(" ")}`,
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

/**
 * Static-page policy: script-free server-rendered HTML. `default-src 'none'` covers
 * `script-src`/`connect-src`/`object-src` (no fallback needed); `form-action` and
 * `frame-ancestors` have no fallback so they are stated explicitly.
 */
const STATIC_HTML_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
].join("; ");

/**
 * One year, subdomains included. The worker is HTTPS-only behind Cloudflare; without HSTS a
 * `Secure` cookie is still protected but the *first* navigation can be downgraded, and the
 * `__Host-` cookie prefix's guarantees assume the origin is never reachable over http.
 * `preload` is deliberately omitted — that is an operator decision, not a code one.
 */
const HSTS = "max-age=31536000; includeSubDomains";

function commonHeaders(headers: Headers): Headers {
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  headers.set("strict-transport-security", HSTS);
  return headers;
}

/** Headers for the admin/portal SPA shells and every JSON API response. */
export function appSecurityHeaders(headers = new Headers()): Headers {
  commonHeaders(headers);
  headers.set("content-security-policy", APP_CSP);
  return headers;
}

/**
 * Headers for server-rendered, script-free HTML (sign-in errors, device-authorization page,
 * "you're signed in" page, the edge-mint auth page).
 *
 * NOTE for `services/identity/oidc.ts`: both HTML responses there —
 * `handleAuthDeviceVerify`'s confirmation page and `handleAuthCallback`'s "You're signed in"
 * page — should build their headers with this helper, e.g.
 *   `headers: staticHtmlSecurityHeaders(new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }))`
 * Until they do, `secureResponse` in `index.ts` backstops them at dispatch time.
 */
export function staticHtmlSecurityHeaders(headers = new Headers()): Headers {
  commonHeaders(headers);
  headers.set("content-security-policy", STATIC_HTML_CSP);
  return headers;
}

/** Copy headers, preserving each `set-cookie` as its own field (never comma-joined). */
function copyHeaders(src: Headers): Headers {
  const out = new Headers();
  src.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") out.append(key, value);
  });
  // `getSetCookie()` is the only way to keep multiple Set-Cookie fields distinct; it is not in
  // the pinned @cloudflare/workers-types Headers yet, so feature-detect it.
  const getAllCookies = (src as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  const cookies =
    typeof getAllCookies === "function" ? getAllCookies.call(src) : [];
  if (cookies.length > 0) {
    for (const c of cookies) out.append("set-cookie", c);
  } else {
    const one = src.get("set-cookie");
    if (one) out.append("set-cookie", one);
  }
  return out;
}

/**
 * Origin-wide backstop, applied to EVERY response in `index.ts`.
 *
 * Adds HSTS everywhere, and a CSP to any `text/html` response that did not already set one.
 * This is what makes "no CSP-less HTML on this origin" an invariant of the dispatcher rather
 * than a convention each handler has to remember (R1-09): a new HTML response added anywhere
 * is hardened by default, and handlers that DO set their own policy (the SPA shells) keep it.
 */
export function secureResponse(res: Response): Response {
  const isHtml = (res.headers.get("content-type") ?? "").includes("text/html");
  const needsCsp = isHtml && !res.headers.has("content-security-policy");
  if (!needsCsp && res.headers.has("strict-transport-security")) return res;
  const headers = copyHeaders(res.headers);
  headers.set("strict-transport-security", HSTS);
  if (needsCsp) staticHtmlSecurityHeaders(headers);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}
