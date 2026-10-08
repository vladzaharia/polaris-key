/**
 * Small HTTP helpers the login card's handlers share (I-07). The card's JSON answers carry the
 * portal's security headers and `no-store`; its server-rendered pages are the branded,
 * script-free shell (`core/brandHtml.ts`) under the branded-page CSP.
 */

import {
  brandedHtmlSecurityHeaders,
  escapeHtml,
  type Env,
} from "../../../core/platform.js";
import { renderBrandPage } from "../../../core/brandHtml.js";
import { portalSecurityHeaders } from "../portal/headers.js";

/** A JSON answer. `cookies` become separate `Set-Cookie` fields. */
export function cardJson(
  body: unknown,
  status = 200,
  cookies: readonly string[] = [],
): Response {
  const headers = portalSecurityHeaders(
    new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** A redirect, with the portal's headers and any cookies. */
export function cardRedirect(
  location: string,
  cookies: readonly string[] = [],
): Response {
  const headers = portalSecurityHeaders(
    new Headers({ location, "cache-control": "no-store" }),
  );
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

/**
 * The one way back from a Worker sign-in page (SIGN-IN.md §3.13): **Sign in again**, to the
 * sign-in page or to a same-origin `href` the caller already checked. `// signin.again`
 */
export function signInAgainAction(href = "/"): string {
  return `<p class="actions"><a class="button" href="${escapeHtml(href)}">Sign in again</a></p>`;
}

/**
 * The wrong-code message (SIGN-IN.md §3.4): `signin.code.wrong`, plus `signin.code.triesLeft`
 * when two or fewer tries are left, or `signin.code.tooMany` when none are.
 */
export function wrongCodeMessage(triesLeft: number): string {
  if (triesLeft <= 0) return "Too many tries. Send a new code."; // signin.code.tooMany
  const wrong = "That code isn't right. Check the email and try again."; // signin.code.wrong
  if (triesLeft > 2) return wrong;
  // signin.code.triesLeft
  return `${wrong} ${triesLeft === 1 ? "1 try left." : `${triesLeft} tries left.`}`;
}

/** A branded, script-free page. `body` is TRUSTED markup: every value in it already escaped. */
export function cardPage(
  status: number,
  page: { title: string; heading: string; body?: string },
  cookies: readonly string[] = [],
): Response {
  const headers = brandedHtmlSecurityHeaders(
    new Headers({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    }),
  );
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(
    // No surface label beside the wordmark: sign-in pages carry no eyebrow (SIGN-IN.md §3.13,
    // D-32).
    renderBrandPage({
      title: page.title,
      heading: page.heading,
      body: page.body ?? "",
    }),
    { status, headers },
  );
}

/** A request body as a JSON object, or `null` when it is not one. */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await req.text();
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A plausible email address, normalised (trimmed, lower-case), or `null`. */
export function parseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * Where a request came from, for "requested at <time> from <place>" (S-16 §5.4 item 4): the
 * city and country Cloudflare attaches to the request, as data; "an unknown location" when the
 * edge supplied none (tests, local development).
 */
export function requestPlace(req: Request): string {
  const cf = (req as Request & { cf?: Record<string, unknown> }).cf;
  const city = typeof cf?.city === "string" ? cf.city.trim() : "";
  const country = typeof cf?.country === "string" ? cf.country.trim() : "";
  const parts = [city, country].filter((p) => p !== "" && p.length <= 64);
  return parts.length > 0 ? parts.join(", ") : "an unknown location";
}

/** A unix time as a readable UTC instant: "2026-10-04 14:34 UTC". */
export function utcLabel(at: number): string {
  return `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The origin notices and links are built from. */
export function originOf(req: Request): string {
  return new URL(req.url).origin;
}

export type { Env };
