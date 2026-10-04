/// <reference types="@cloudflare/workers-types" />
/**
 * The registry host's landing page: `GET /` (and `HEAD /`) on `PKG_ORIGIN`, `pkg.plrs.im` and
 * its `pkg-staging` / `pkg-dev` siblings (F-02, plans/F-01.md §6.1). Nothing else.
 *
 * It is the bytes host's page (`bytesLanding.ts`, BRAND §8) with its own two sentences, and it
 * keeps every one of that page's guarantees:
 *
 *   - ONE exact path, GET and HEAD only, on the registry host only (`dispatchRegistryHost`
 *     calls this before any route; no other host reaches it).
 *   - A STATIC document: built from the brand package's marks and tokens and two validated
 *     deployment variables (`CONSOLE_ORIGIN`, `PKG_ORIGIN`). No request input, no D1, KV or R2.
 *   - NO SCRIPT, NO REQUESTS: the same stylesheet and the same inert-document policy
 *     (`landingCsp`), which the dispatcher checks with `inertDocumentPolicy` before it leaves.
 *     The marks are inline SVG and the favicon a `data:` URI.
 *   - The host's own headers still apply (`hardenRegistryHostResponse`).
 *
 * The lockup is "Polaris Key Delivery" (the Star Cut service mark, BRAND §1.1): the registry host
 * is Distribution's, as the bytes host is, so it shares that host's mark and green accent.
 */

import { THEME_TOKENS } from "@polaris-key/brand";
import type { Env } from "../env.js";
import { normalizeHostname } from "./bytesHostname.js";
import {
  LANDING_CACHE,
  LANDING_CSS,
  escapeHtml,
  landingArt,
  landingCsp,
} from "./bytesLanding.js";
import { registryHostname } from "./registryHostname.js";

/** The console origin to link when `CONSOLE_ORIGIN` is unset or unusable: the platform's own. */
const DEFAULT_CONSOLE_ORIGIN = "https://key.plrs.im";

/** Is `pathname` the landing page's path? Exactly `/`, nothing else. */
export function isRegistryLandingPath(pathname: string): boolean {
  return pathname === "/";
}

function registryHostIsHttp(env: Env): boolean {
  try {
    return (
      typeof env.PKG_ORIGIN === "string" &&
      new URL(env.PKG_ORIGIN).protocol === "http:"
    );
  } catch {
    return false;
  }
}

/**
 * The validated console origin to link: `CONSOLE_ORIGIN` when usable, else the platform's.
 * `https:` always; `http:` only when the registry host is itself `http:` (local development).
 */
export function registryLandingConsoleOrigin(env: Env): string {
  const raw = env.CONSOLE_ORIGIN;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const u = new URL(raw);
      if (
        (u.protocol === "https:" ||
          (u.protocol === "http:" && registryHostIsHttp(env))) &&
        normalizeHostname(u.hostname) !== registryHostname(env)
      )
        return u.origin;
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_CONSOLE_ORIGIN;
}

/** The environment a non-production registry host names, from its first DNS label:
 *  `pkg-staging…` is "Staging", `pkg-dev…` "Development", `pkg.…` (production) nothing. */
export function registryLandingEnvironment(env: Env): string | null {
  const host = registryHostname(env);
  const m = host ? /^pkg-([a-z0-9]{1,20})\./.exec(host) : null;
  if (!m) return null;
  const word = m[1]!;
  if (word === "dev") return "Development";
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The landing page's HTML for this deployment. */
export function renderRegistryLandingPage(env: Env): string {
  const { lockups, faviconHref } = landingArt();
  const consoleOrigin = registryLandingConsoleOrigin(env);
  const environment = registryLandingEnvironment(env);
  const title = environment
    ? `Polaris Key Delivery (${environment})`
    : "Polaris Key Delivery";
  const description =
    "The package registry for libraries and tools published through Polaris Key.";
  return [
    `<!doctype html>`,
    `<html lang="en">`,
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
    `<h1>${lockups}</h1>`,
    environment
      ? `<p class="env">${escapeHtml(environment)} environment</p>`
      : "",
    `<p class="lede">${escapeHtml(description)}</p>`,
    `<p class="about">Package managers fetch from here, each from its owner's feed. Setup lines for every client are in the console. There is nothing to browse.</p>`,
    `<nav aria-label="Polaris Key">`,
    `<ul>`,
    `<li><a href="${escapeHtml(`${consoleOrigin}/`)}">Open the console</a></li>`,
    `<li><a href="${escapeHtml(`${consoleOrigin}/docs/`)}">Read the docs <small>(sign-in required)</small></a></li>`,
    `</ul>`,
    `</nav>`,
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}

/** The landing page's answer for `req` (GET or HEAD), before the host's own hardening. */
export async function registryLandingResponse(
  req: Request,
  env: Env,
): Promise<Response> {
  const html = renderRegistryLandingPage(env);
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
