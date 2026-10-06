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
 *   - `brandedHtmlSecurityHeaders` — the Worker's own branded interstitials (sign-in errors,
 *     the device-authorization pages, the "you're signed in" page; `core/brandHtml.ts`).
 *     These pages have no scripts at all, so `default-src 'none'` is achievable: an injected
 *     `<script>` cannot execute and an injected `fetch()` cannot reach `/manage/api/*`. Their
 *     one stylesheet is allowed by its SHA-256 and the brand font by `font-src 'self'`; no
 *     `'unsafe-inline'`, so an injected `<style>` or `style=` does not apply either.
 *   - `staticHtmlSecurityHeaders` — any other script-free HTML: the operator-supplied edge-mint
 *     auth page, and the dispatcher's backstop for an HTML response that set no policy.
 *     Inline *styles* are allowed because such pages may be styled with `style=` attributes;
 *     with `default-src 'none'` the worst a CSS injection can do is load an image from
 *     `'self'`.
 */

import { ADMIN_SCRIPT_HASHES } from "./adminCsp.js";
import { brandPageStyleSource } from "./core/brandHtml.js";

/**
 * SPA + JSON policy: the admin/portal bundles execute their own scripts, plus the shells' one
 * inline pre-paint theme script, allowed by its hash.
 *
 * `img-src` may add exactly ONE more source: the image host's origin (`IMG_ORIGIN`, HA-02), for
 * the console's product logos. It is passed per response by the shell that needs it
 * (`admin/index.ts`), never a wildcard and never a scheme or a path: the host serves only public,
 * content-addressed raster images under `default-src 'none'; sandbox` (THREAT-MODEL, "The image
 * host"), so an image from it can run nothing here.
 */
function appCsp(imgOrigin: string | null): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src ${["'self'", ...ADMIN_SCRIPT_HASHES].join(" ")}`,
    "style-src 'self'",
    `img-src 'self' data:${imgOrigin ? ` ${imgOrigin}` : ""}`,
    "connect-src 'self'",
  ].join("; ");
}

const APP_CSP = appCsp(null);

/**
 * A bare `https://host[:port]` origin (lowercase, no path, no wildcard, no whitespace or `;`), or
 * `null`. `http:` is accepted only for a loopback host, so a local `wrangler dev` image host
 * works while a deployed one is always HTTPS. Anything else is dropped rather than written into
 * the policy.
 */
export function cspImageOrigin(
  origin: string | null | undefined,
): string | null {
  if (typeof origin !== "string") return null;
  const m = /^(https?):\/\/([a-z0-9.-]+)(?::(\d{1,5}))?$/.exec(origin);
  if (!m) return null;
  const [, scheme, host] = m;
  if (host!.startsWith(".") || host!.endsWith(".") || host!.includes(".."))
    return null;
  const loopback = host === "localhost" || host === "127.0.0.1";
  if (scheme === "http" && !loopback) return null;
  return origin;
}

/** Per-response additions to the SPA policy. */
export interface AppSecurityOptions {
  /**
   * The image host's origin (`imgOrigin(env)`): the console shell's `img-src` adds exactly it.
   * Omitted, `null` or not a bare origin (`cspImageOrigin`), the policy is unchanged.
   */
  imgOrigin?: string | null;
}

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
 * Branded-page policy: the static-page policy with the inline-style allowance replaced by the
 * one stylesheet's hash, plus the brand font from this origin. `form-action 'self'` stays a
 * literal token: the device pages widen it by one IdP origin (`oidc.ts`).
 */
function brandedHtmlCsp(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    `style-src ${brandPageStyleSource()}`,
    "font-src 'self'",
  ].join("; ");
}

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
export function appSecurityHeaders(
  headers = new Headers(),
  opts: AppSecurityOptions = {},
): Headers {
  commonHeaders(headers);
  const img = cspImageOrigin(opts.imgOrigin);
  headers.set("content-security-policy", img ? appCsp(img) : APP_CSP);
  return headers;
}

/**
 * Headers for server-rendered, script-free HTML that is not one of the branded pages: the
 * operator-supplied edge-mint auth page (`services/config/mint.ts`) and the dispatcher's
 * backstop (`secureResponse`). The Worker's own pages use `brandedHtmlSecurityHeaders`.
 */
export function staticHtmlSecurityHeaders(headers = new Headers()): Headers {
  commonHeaders(headers);
  headers.set("content-security-policy", STATIC_HTML_CSP);
  return headers;
}

/**
 * Headers for the Worker's branded, script-free pages (`core/brandHtml.ts`): sign-in errors,
 * the device-authorization pages and the "you're signed in" page. Same hardening as
 * `staticHtmlSecurityHeaders`, with a policy that allows only the brand stylesheet and font.
 */
export function brandedHtmlSecurityHeaders(headers = new Headers()): Headers {
  commonHeaders(headers);
  headers.set("content-security-policy", brandedHtmlCsp());
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
