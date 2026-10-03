/// <reference types="@cloudflare/workers-types" />
/**
 * The bytes host's landing page: `GET /` (and `HEAD /`) on `BLOB_ORIGIN`, `dl.plrs.im` and its
 * `dl-staging` / `dl-dev` siblings. Nothing else. docs/design/BRAND.md §8 is its contract.
 *
 * ── WHY ONE HTML ANSWER ON THIS HOST IS SAFE ────────────────────────────────────────────────
 *
 * The bytes host is same-site with the console (`key.plrs.im`), so it must never serve anything
 * a browser could run as script (`core/bytesHost.ts`, THREAT-MODEL §3). This page keeps every
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
 * The "Polaris Key Delivery" horizontal lockup (the Star Cut service mark, BRAND §1.1) at 80 px
 * tall, so its glyph is the display cut at 48 px (BRAND §1.3-1.4), and the compact lockup below
 * 400 px of width, where the full one would shrink its glyph under 48 px. The lockup is the
 * brand package's geometry (`lockupMetrics`: the kit's Star Cut and a Rubik Bold wordmark
 * outlined from the bundled font), with its colour roles turned into classes so one inline SVG
 * follows the system theme: dark first, light under `prefers-color-scheme: light`, no toggle
 * (BRAND §8, a one-screen page). The lockups are built on the first request to `/` and kept,
 * so a template the page cannot theme fails that request, never the Worker's module load.
 *
 * TYPE: the system stack behind Rubik (`FONT.sans`), with no `@font-face`. The wordmark is
 * outlined in the lockup, so the brand's own type is exact where it identifies the service;
 * the rest is two short sentences. Serving Rubik would mean either a font route and a font type
 * on this host's allowlist, or a `font-src` in the inert-document policy plus ~100 KB of inline
 * WOFF2: each widens the one check that keeps HTML on this host inert, for no gain in identity.
 * A visitor who has Rubik installed sees it.
 *
 * FAVICON: the kit's adaptive Star Cut favicon (`web/update/favicon.svg`), redrawn from the
 * brand geometry and inlined as a `data:` URI, so no icon route or icon type is needed.
 */

import { BRAND, FONT, SERVICE_ACCENTS, THEME_TOKENS } from "@polaris-key/brand";
import { lockupMetrics, markParts } from "@polaris-key/brand/svg";
import type { Env } from "../env.js";
import { bytesHostname, normalizeHostname } from "./bytesHostname.js";

/** The landing page's Cache-Control: the page changes only with a deploy. */
export const LANDING_CACHE = "public, max-age=3600";

/** The console origin to link when `CONSOLE_ORIGIN` is unset or unusable: the platform's own. */
const DEFAULT_CONSOLE_ORIGIN = "https://key.plrs.im";

/** Is `pathname` the landing page's path? Exactly `/`, nothing else. */
export function isLandingPath(pathname: string): boolean {
  return pathname === "/";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// ── Artwork ──────────────────────────────────────────────────────────────────────────────────

/** The lockup's colour roles, as classes the stylesheet fills per theme. */
const ROLE_CLASS = { body: "mb", star: "ms", text: "mt" } as const;

/**
 * A Polaris Key Delivery lockup as inline SVG whose colours come from the page's stylesheet.
 * The geometry is the brand template's, untouched; only `fill="{role}"` becomes a class. A
 * template with any other placeholder (a gold bit, a plate) is a brand change this page must
 * not follow silently, so it throws (on the first request; the tests fail).
 */
function themedLockup(
  layout: "horizontal" | "compact",
  height: number,
  className: string,
): string {
  const m = lockupMetrics({ kind: "delivery", layout, height });
  const body = m.template.body.replace(
    /fill="\{(\w+)\}"/g,
    (_, role: string) => {
      const cls = ROLE_CLASS[role as keyof typeof ROLE_CLASS];
      if (!cls) throw new Error(`landing: unexpected lockup role ${role}`);
      return `class="${cls}"`;
    },
  );
  if (body.includes("{"))
    throw new Error("landing: unresolved lockup placeholder");
  const w = Math.round(m.width * 100) / 100;
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${m.template.width} ${m.template.height}" role="img" aria-label="${escapeHtml(m.template.title)}"><title>${escapeHtml(m.template.title)}</title>${body}</svg>`;
}

/**
 * The kit's adaptive favicon (`web/update/favicon.svg`): the 16 px Star Cut drawing, light
 * inks by default and dark inks under `prefers-color-scheme: dark`, as the kit file does.
 */
export function landingFaviconSvg(): string {
  const { parts } = markParts({ kind: "update", size: 16, theme: "light" });
  const paths = parts
    .map(
      (p) =>
        `<path class="${p.role === "star" ? "star" : "body"}" d="${p.d}"/>`,
    )
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<style>.body,.star{fill:${BRAND.violet.light}}@media(prefers-color-scheme:dark){.body{fill:${BRAND.violet.dark}}.star{fill:${BRAND.star.dark}}}</style>` +
    `${paths}</svg>`
  );
}

// ── Stylesheet ───────────────────────────────────────────────────────────────────────────────

function palette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  // The delivery green, now Distribution's alone (Update became tangerine on 2026-10-03,
  // BRAND.md §5); the bytes host serves Distribution's downloads, so the page stays green.
  const accent = SERVICE_ACCENTS[theme].distribution;
  return [
    `color-scheme:${theme}`,
    `--page:${t.surface.page}`,
    `--strong:${t.text.strong}`,
    `--text:${t.text.default}`,
    `--muted:${t.text.muted}`,
    `--rule:${t.border.subtle}`,
    `--edge:${t.border.strong}`,
    `--accent:${accent.fg}`,
    `--accent-subtle:${accent.subtle}`,
    `--focus:${t.focus}`,
    `--mb:${BRAND.violet[theme]}`,
    `--ms:${BRAND.star[theme]}`,
    `--mt:${BRAND.text[theme]}`,
  ].join(";");
}

/**
 * The page's one stylesheet. Constant per build (no request or deployment input), so its
 * SHA-256 in the policy is constant too.
 */
export const LANDING_CSS = [
  `:root{${palette("dark")}}`,
  `@media (prefers-color-scheme: light){:root{${palette("light")}}}`,
  `*{box-sizing:border-box}`,
  `html{background:var(--page)}`,
  `body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:3rem 1rem;background:var(--page);color:var(--text);font-family:${FONT.sans};font-synthesis:none;font-size:1rem;line-height:1.5;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}`,
  `main{width:100%;max-width:34rem}`,
  `h1{margin:0;padding:20px 0;line-height:0}`,
  `h1 svg{display:block;max-width:100%;height:auto}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
  `.lockup-compact{display:none}`,
  `@media (max-width: 399.98px){.lockup-full{display:none}.lockup-compact{display:block}}`,
  `.env{margin:.25rem 0 0;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.lede{margin:1.5rem 0 0;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:700;letter-spacing:-.01em}`,
  `.about{margin:.75rem 0 0;color:var(--muted)}`,
  `nav{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--rule)}`,
  `nav ul{display:flex;flex-wrap:wrap;gap:.75rem;margin:0;padding:0;list-style:none}`,
  `nav a{display:inline-flex;align-items:center;gap:.5rem;min-height:44px;padding:.625rem 1rem;border:1px solid var(--edge);border-radius:.5rem;color:var(--accent);font-weight:700;text-decoration:none}`,
  `nav a:hover{background:var(--accent-subtle);border-color:var(--accent)}`,
  `nav a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `nav small{color:var(--muted);font-weight:400;font-size:.875rem}`,
  `@media (prefers-reduced-motion: no-preference){nav a{transition:background-color 120ms ease,border-color 120ms ease}}`,
].join("");

let cspPromise: Promise<string> | null = null;

/** The page's Content-Security-Policy: the inert-document policy `bytesHost.ts` checks. */
export function landingCsp(): Promise<string> {
  cspPromise ??= (async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(LANDING_CSS),
    );
    let bin = "";
    for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
    return [
      "sandbox",
      "default-src 'none'",
      `style-src 'sha256-${btoa(bin)}'`,
      "img-src data:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  })();
  return cspPromise;
}

// ── The document ─────────────────────────────────────────────────────────────────────────────

/** Is the bytes host itself served over plain http (local development)? */
function bytesHostIsHttp(env: Env): boolean {
  try {
    return (
      typeof env.BLOB_ORIGIN === "string" &&
      new URL(env.BLOB_ORIGIN).protocol === "http:"
    );
  } catch {
    return false;
  }
}

/**
 * The validated console origin to link: `CONSOLE_ORIGIN` when usable, else the platform's.
 * `https:` always; `http:` only when the bytes host is itself `http:` (local development), so a
 * deployed page never links the console over plain http.
 */
export function landingConsoleOrigin(env: Env): string {
  const raw = env.CONSOLE_ORIGIN;
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const u = new URL(raw);
      if (
        (u.protocol === "https:" ||
          (u.protocol === "http:" && bytesHostIsHttp(env))) &&
        normalizeHostname(u.hostname) !== bytesHostname(env)
      )
        return u.origin;
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_CONSOLE_ORIGIN;
}

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

interface LandingArt {
  lockups: string;
  faviconHref: string;
}

let art: LandingArt | null = null;

/**
 * The page's artwork, built on first use and kept for the isolate's life. Lazy so that a brand
 * template this page cannot theme fails the first request to `/`, not the Worker's module load
 * (which would take every route on both hosts down with it).
 */
function landingArt(): LandingArt {
  art ??= {
    lockups:
      themedLockup("horizontal", 80, "lockup-full") +
      themedLockup("compact", 64, "lockup-compact"),
    faviconHref: `data:image/svg+xml,${encodeURIComponent(landingFaviconSvg())}`,
  };
  return art;
}

/** The landing page's HTML for this deployment. */
export function renderLandingPage(env: Env): string {
  const { lockups, faviconHref } = landingArt();
  const consoleOrigin = landingConsoleOrigin(env);
  const environment = landingEnvironment(env);
  const title = environment
    ? `Polaris Key Delivery (${environment})`
    : "Polaris Key Delivery";
  const description =
    "The download host for games and apps built on Polaris Key.";
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
    `<p class="about">Files here are signed release artifacts and packs, fetched by apps and their updaters. There is nothing to browse.</p>`,
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
