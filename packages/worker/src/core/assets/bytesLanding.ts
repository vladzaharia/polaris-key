/// <reference types="@cloudflare/workers-types" />
/**
 * The bytes host's landing page: `GET /` (and `HEAD /`) on `BLOB_ORIGIN`, `dl.plrs.im` and its
 * `dl-staging` / `dl-dev` siblings. Nothing else. docs/design/BRAND.md §8 is its contract.
 *
 * ── WHY ONE HTML ANSWER ON THIS HOST IS SAFE ────────────────────────────────────────────────
 *
 * The bytes host is same-site with the console (`key.plrs.im`), so it must never serve anything
 * a browser could run as script (`core/assets/bytesHost.ts`, THREAT-MODEL §3). This page keeps every
 * one of that file's guarantees and adds no route, type or header rule:
 *
 *   - ONE exact path. Only `/`, only GET and HEAD, only on the bytes host (`dispatchBytesHost`
 *     calls this before any byte route; the console host never reaches it). Every other path,
 *     method and host answers exactly as before, `/favicon.ico` included.
 *   - A STATIC document. No request input reaches the body: the markup is built from the brand
 *     package's marks and tokens (the lockups once, on the first request) and two deployment variables
 *     (`CONSOLE_ORIGIN`, `BLOB_ORIGIN`), both validated, the one dynamic word escaped. No
 *     product, release, file, token or key is read; no D1, KV or R2 call is made.
 *   - NO SCRIPT, NO REQUESTS. The policy is the inert-document policy `bytesHost.ts` already
 *     checks for the download page (`inertDocumentPolicy`), and the dispatcher runs this answer
 *     through that same check: `sandbox` with no tokens (an opaque origin; no script, forms,
 *     popups or plugins), `default-src 'none'`, the one stylesheet by its SHA-256, images only
 *     as `data:` (the favicon), `frame-ancestors`, `base-uri` and `form-action` all `'none'`.
 *     The marks are inline SVG; there is no font file, script, stylesheet or image to fetch.
 *   - The host's own headers still apply (`hardenBytesHostResponse`): `nosniff`,
 *     `Referrer-Policy: no-referrer`, every `Set-Cookie` stripped. The page sets none.
 *
 * ── DESIGN CHOICES ──────────────────────────────────────────────────────────────────────────
 *
 * The Polaris Locker horizontal lockup at 48 px tall, with the Star Cut (Delivery's service
 * symbol, BRAND §1.1) and "Delivery" in a row under it (LK-07, plans/LK-00.md §14.2: services keep
 * their symbols under a Locker header). Both are the brand package's geometry, inline SVG whose
 * colour roles are classes the stylesheet fills, so one drawing follows the system theme: dark
 * first, light under `prefers-color-scheme: light`, no toggle (BRAND §8, a one-screen page).
 * They are built where `lockerShell.ts` draws them, per request (a few kilobytes of strings).
 *
 * TYPE: the system stack behind Rubik (`FONT.sans`), with no `@font-face`. The wordmark is
 * outlined in the lockup, so the brand's own type is exact where it identifies the service;
 * the rest is two short sentences. Serving Rubik would mean either a font route and a font type
 * on this host's allowlist, or a `font-src` in the inert-document policy plus ~100 KB of inline
 * WOFF2: each widens the one check that keeps HTML on this host inert, for no gain in identity.
 * A visitor who has Rubik installed sees it.
 *
 * FAVICON: the kit's adaptive Locker favicon (`locker-kit/web/favicon.svg`), redrawn from the
 * brand geometry and inlined as a `data:` URI, so no icon route or icon type is needed.
 */

import { FONT, THEME_TOKENS } from "@polaris-key/brand";
import { PORTAL_COPY_EN } from "@polaris-key/brand/kit-copy/portal";
import type { Env } from "../../platform/env.js";
import { bytesHostname, customerOrigin, customerSiteOrigin } from "../hosts.js";
import { BRAND_LOCKUP_HEIGHT } from "../brandHtml.js";
import { escapeHtml } from "../../platform/html.js";
import { sha256Base64 } from "../../platform/hash.js";
import {
  LOCKER_LOCKUP_CSS,
  lockerFaviconHref,
  lockerLockup,
} from "./lockerShell.js";

/** The landing page's Cache-Control: the page changes only with a deploy. */
export const LANDING_CACHE = "public, max-age=3600";

/** Is `pathname` the landing page's path? Exactly `/`, nothing else. */
export function isLandingPath(pathname: string): boolean {
  return pathname === "/";
}

// ── Artwork ──────────────────────────────────────────────────────────────────────────────────
//
// The Polaris Locker shell (`lockerShell.ts`): the Locker lockup with the Star Cut as Delivery's
// service symbol under it, and the Locker favicon inlined as a `data:` URI.

export { lockerFaviconSvg as landingFaviconSvg } from "./lockerShell.js";

// ── Stylesheet ───────────────────────────────────────────────────────────────────────────────

/** The landing pages' shared stylesheet body around a palette and the lockup's inks. */
export function landingCss(
  palette: (theme: "dark" | "light") => string,
  tail: string,
): string {
  return [
    `:root{${palette("dark")}}`,
    `@media (prefers-color-scheme: light){:root{${palette("light")}}}`,
    `*{box-sizing:border-box}`,
    `html{background:var(--page)}`,
    `body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:3rem 1rem;background:var(--page);color:var(--text);font-family:${FONT.sans};font-synthesis:none;font-size:1rem;line-height:1.5;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}`,
    `main{width:100%;max-width:34rem}`,
    `h1{margin:0;padding:20px 0;line-height:0}`,
    `h1 svg{display:block;max-width:100%;height:auto}`,
    `.env{margin:.25rem 0 0;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
    `.lede{margin:1.5rem 0 0;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:600;letter-spacing:-.01em}`,
    `.about{margin:.75rem 0 0;color:var(--muted)}`,
    `nav{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--rule)}`,
    `nav ul{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}`,
    `nav a{display:inline-flex;align-items:center;gap:.5rem;min-height:44px;padding:.625rem 1rem;border:1px solid var(--edge);border-radius:.5rem;color:var(--accent);font-weight:500;text-decoration:none}`,
    `nav a:hover{background:var(--accent-subtle);border-color:var(--accent)}`,
    `nav a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
    `@media (prefers-reduced-motion: no-preference){nav a{transition:background-color 120ms ease,border-color 120ms ease}}`,
    tail,
  ].join("");
}

function palette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  // A customer surface (Polaris Locker): neutral ink for the one link, no service accent.
  return [
    `color-scheme:${theme}`,
    `--page:${t.surface.page}`,
    `--strong:${t.text.strong}`,
    `--text:${t.text.default}`,
    `--muted:${t.text.muted}`,
    `--rule:${t.border.subtle}`,
    `--edge:${t.border.strong}`,
    `--accent:${t.text.strong}`,
    `--accent-subtle:${t.surface.sunken}`,
    `--focus:${t.text.strong}`,
  ].join(";");
}

/**
 * The page's one stylesheet. Constant per build (no request or deployment input), so its
 * SHA-256 in the policy is constant too.
 */
export const LANDING_CSS = landingCss(palette, LOCKER_LOCKUP_CSS);

const cspByCss = new Map<string, Promise<string>>();

/**
 * The page's Content-Security-Policy: the inert-document policy `bytesHost.ts` checks, for the
 * given stylesheet (the registry landing has its own).
 */
export function landingCsp(css: string = LANDING_CSS): Promise<string> {
  let p = cspByCss.get(css);
  if (!p) {
    p = (async () => {
      const styleHash = await sha256Base64(css);
      return [
        "sandbox",
        "default-src 'none'",
        `style-src 'sha256-${styleHash}'`,
        "img-src data:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; ");
    })();
    cspByCss.set(css, p);
  }
  return p;
}

// ── The document ─────────────────────────────────────────────────────────────────────────────

/**
 * The environment a non-production bytes host names, from its first DNS label: `dl-staging…` is
 * "Staging", `dl-dev…` is "Development", any other `dl-<word>…` its word; `dl.…` (production)
 * and any other host name nothing.
 */
export function landingEnvironment(env: Env): string | null {
  const host = bytesHostname(env);
  const m = host ? /^dl-([a-z0-9]{1,20})\./.exec(host) : null;
  if (!m) return null;
  const word = m[1]!;
  if (word === "dev") return "Development";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The head and heading of the download host's landing page: the title, the Polaris Locker
 * lockup and its favicon. A customer surface (BRAND §8), so no service symbol and no accent.
 */
export function landingShell(environment: string | null): {
  title: string;
  lockups: string;
  faviconHref: string;
} {
  return {
    title: `Downloads${environment ? ` (${environment})` : ""} · Polaris Locker`,
    lockups: lockerLockup(BRAND_LOCKUP_HEIGHT.lockerBar, "lockup", true),
    faviconHref: lockerFaviconHref(),
  };
}

/** The document around one page's `main` content: the shared head, stylesheet and lockup. */
function renderDocument(
  title: string,
  description: string,
  environment: string | null,
  faviconHref: string,
  main: string[],
): string {
  return [
    `<!doctype html>`,
    `<html lang="en" data-brand="locker">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta name="theme-color" content="${THEME_TOKENS.dark.surface.page}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${THEME_TOKENS.light.surface.page}" media="(prefers-color-scheme: light)">`,
    environment ? `<meta name="robots" content="noindex, nofollow">` : "",
    `<link rel="icon" type="image/svg+xml" href="${escapeHtml(faviconHref)}">`,
    `<style>${LANDING_CSS}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    ...main,
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}

/** The landing page's HTML for this deployment. */
export function renderLandingPage(env: Env): string {
  // The one link goes to Polaris Locker, and only when this deployment has a customer site.
  const lockerOrigin = customerSiteOrigin(env);
  const environment = landingEnvironment(env);
  const { title, lockups, faviconHref } = landingShell(environment);
  const description = "The download host for games and apps.";
  return renderDocument(title, description, environment, faviconHref, [
    `<h1>${lockups}</h1>`,
    environment
      ? `<p class="env">${escapeHtml(environment)} environment</p>`
      : "",
    `<p class="lede">${escapeHtml(description)}</p>`,
    `<p class="about">Files here are signed release artifacts and packs, fetched by apps and their updaters. There is nothing to browse.</p>`,
    lockerOrigin
      ? `<nav aria-label="Polaris Locker"><ul><li><a href="${escapeHtml(`${lockerOrigin}/`)}">Open Polaris Locker</a></li></ul></nav>`
      : "",
  ]);
}

// ── The expired-link page (HA-09F) ───────────────────────────────────────────────────────────

/**
 * Marks a route answer as an error DOCUMENT: the one HTML answer this host admits at a 4xx
 * status. The dispatcher strips it, then checks the page like the landing page (inert policy,
 * exactly `410` and `text/html; charset=utf-8`); anything else carrying it is the plain not-found.
 */
export const ERROR_DOCUMENT_HEADER = "x-pkey-error-document";

/** The only status an error document may carry. */
export const ERROR_DOCUMENT_STATUS = 410;

/**
 * The page a browser navigation meets when a download link no longer works (an expired or
 * invalid ticket). Static but for the product slug in the one link back to its page in Polaris
 * Locker (a validated slug, escaped); no ticket, file or account is read or shown. The words are
 * the catalog's (`locker.error.downloadLink.*`).
 */
export async function expiredLinkResponse(
  env: Env,
  productSlug: string,
): Promise<Response> {
  // Only a deployment with a customer site has a page to go back to (`customerOrigin` is the one
  // source of customer URLs).
  const customer =
    customerSiteOrigin(env) === null ? null : customerOrigin(env, "");
  const environment = landingEnvironment(env);
  const { lockups, faviconHref } = landingShell(environment);
  const title = PORTAL_COPY_EN["locker.error.downloadLink.title"];
  const back = customer
    ? `${customer}/#/p/${encodeURIComponent(productSlug)}`
    : null;
  const html = renderDocument(
    `${title} · Polaris Locker`,
    title,
    environment,
    faviconHref,
    [
      `<h1>${lockups}</h1>`,
      `<p class="lede">${escapeHtml(title)}</p>`,
      `<p class="about">${escapeHtml(PORTAL_COPY_EN["locker.error.downloadLink.body"])}</p>`,
      back
        ? `<nav aria-label="Polaris Locker"><ul><li><a href="${escapeHtml(back)}">${escapeHtml(PORTAL_COPY_EN["locker.error.downloadLink.back"])}</a></li></ul></nav>`
        : "",
    ],
  );
  return new Response(html, {
    status: ERROR_DOCUMENT_STATUS,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await landingCsp(),
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      [ERROR_DOCUMENT_HEADER]: "1",
    },
  });
}

/** The landing page's answer for `req` (GET or HEAD), before the host's own hardening. */
export async function landingResponse(
  req: Request,
  env: Env,
): Promise<Response> {
  const html = renderLandingPage(env);
  return new Response(req.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": await landingCsp(),
      "cache-control": LANDING_CACHE,
      "x-frame-options": "DENY",
    },
  });
}
