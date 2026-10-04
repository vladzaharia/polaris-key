/**
 * The branded shell for every server-rendered page the Worker answers on the console host
 * (`key.plrs.im`): the admin and portal sign-in errors, the device-authorization pages and the
 * "you're signed in" page. docs/design/BRAND.md is the contract: the Pinned K without a bit
 * (§1.1, §7.1), the platform violet as the one accent, the theme tokens from
 * `@polaris-key/brand`, dark first with light under `prefers-color-scheme: light` (§3; no
 * toggle on a one-card page), and Rubik for UI text (§1.6).
 *
 * ── CSP ─────────────────────────────────────────────────────────────────────────────────────
 *
 * The pages are script-free and carry no `style=` attribute: the ONE `<style>` element below is
 * allowed by its SHA-256 (`brandPageStyleSource`, used by `brandedHtmlSecurityHeaders` in
 * `securityHeaders.ts`), so the policy needs neither `'unsafe-inline'` nor a script source.
 * The stylesheet is a constant of the build (tokens only, no request or deployment input), so
 * its hash is too. Rubik comes from `font-src 'self'`: the admin build emits the brand
 * package's WOFF2 files at the stable `/assets/branding/fonts/` path (`packages/admin/
 * vite.config.ts`), which the router already hands to the assets binding. Without the binding
 * (tests, a bare `wrangler dev`) the font 404s and the system stack behind Rubik takes over.
 *
 * The bytes host never uses this shell: its pages stay on the system stack with no font source
 * at all (`bytesLanding.ts`, BRAND.md §8).
 */

import { createHash } from "node:crypto";
import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import { lockupMetrics } from "@polaris-key/brand/svg";

/** Escape for HTML text and double-quoted attribute values. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** Where the admin build emits the brand fonts and the Pinned K web identity. */
export const BRAND_FONT_PATH = "/assets/branding/fonts";
export const BRAND_WEB_KEY_PATH = "/assets/branding/key";

// ── Artwork ──────────────────────────────────────────────────────────────────────────────────

/** A lockup's colour roles, as classes the stylesheet fills per theme. */
const ROLE_CLASS = { body: "mb", star: "ms", text: "mt" } as const;

/**
 * A brand lockup as inline SVG whose colours come from the page's stylesheet, so one drawing
 * follows the system theme. The geometry is the brand template's, untouched. The kit's gold
 * terminal bit is removed (the default mark has no bit, BRAND §6), and any other placeholder is
 * a brand change this code must not follow silently, so it throws (the tests fail).
 */
export function themedLockup(
  kind: "key" | "delivery",
  layout: "horizontal" | "compact",
  height: number,
  className: string,
): string {
  const m = lockupMetrics({ kind, layout, height });
  const body = m.template.body
    .replace(/<path fill="\{gold\}" d="[^"]+"\/>/g, "")
    .replace(/fill="\{(\w+)\}"/g, (_, role: string) => {
      const cls = ROLE_CLASS[role as keyof typeof ROLE_CLASS];
      if (!cls) throw new Error(`brand: unexpected lockup role ${role}`);
      return `class="${cls}"`;
    });
  if (body.includes("{"))
    throw new Error("brand: unresolved lockup placeholder");
  const w = Math.round(m.width * 100) / 100;
  const title = escapeHtml(m.template.title);
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="0 0 ${m.template.width} ${m.template.height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>`;
}

// ── Stylesheet ───────────────────────────────────────────────────────────────────────────────

function palette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  const accent = t.accent.violet;
  const danger = t.status.danger;
  return [
    `color-scheme:${theme}`,
    `--page:${t.surface.page}`,
    `--raised:${t.surface.raised}`,
    `--sunken:${t.surface.sunken}`,
    `--strong:${t.text.strong}`,
    `--text:${t.text.default}`,
    `--muted:${t.text.muted}`,
    `--rule:${t.border.subtle}`,
    `--edge:${t.border.strong}`,
    `--accent:${accent.solid}`,
    `--accent-fg:${accent.fg}`,
    `--on-accent:${accent.on}`,
    `--accent-subtle:${accent.subtle}`,
    `--danger:${danger.fg}`,
    `--danger-edge:${danger.border}`,
    `--danger-subtle:${danger.subtle}`,
    `--focus:${t.focus}`,
    `--mb:${BRAND.violet[theme]}`,
    `--ms:${BRAND.star[theme]}`,
    `--mt:${BRAND.text[theme]}`,
  ].join(";");
}

function fontFace(weight: 400 | 700): string {
  return `@font-face{font-family:"Rubik";font-style:normal;font-weight:${weight};font-display:swap;src:url("${BRAND_FONT_PATH}/rubik-latin-${weight}.woff2") format("woff2")}`;
}

/**
 * The shell's one stylesheet. Constant per build, so its SHA-256 in the policy is constant too.
 */
export const BRAND_PAGE_CSS = [
  fontFace(400),
  fontFace(700),
  `:root{${palette("dark")}}`,
  `@media (prefers-color-scheme: light){:root{${palette("light")}}}`,
  `*{box-sizing:border-box}`,
  `html{background:var(--page)}`,
  `body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:3rem 1rem;background:var(--page);color:var(--text);font-family:${FONT.sans};font-synthesis:none;font-size:1rem;line-height:1.5;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}`,
  `main{width:100%;max-width:28rem}`,
  `.brand{margin:0 0 1.5rem;line-height:0}`,
  `.brand svg{display:block;max-width:100%;height:auto}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
  `.card{padding:2rem;border:1px solid var(--rule);border-radius:10px;background:var(--raised)}`,
  `.eyebrow{margin:0 0 .5rem;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `h1{margin:0 0 .75rem;color:var(--strong);font-size:1.5rem;line-height:2rem;font-weight:700;letter-spacing:-.01em}`,
  `p{margin:0 0 1rem}`,
  `.muted{color:var(--muted)}`,
  `.alert{margin:0 0 1rem;padding:.75rem 1rem;border:1px solid var(--danger-edge);border-radius:6px;background:var(--danger-subtle);color:var(--strong)}`,
  `dl{display:grid;grid-template-columns:6rem 1fr;gap:.5rem 1rem;margin:1.5rem 0;padding:1rem;border-radius:6px;background:var(--sunken)}`,
  `dt{color:var(--muted)}`,
  `dd{margin:0;color:var(--strong);overflow-wrap:anywhere}`,
  `.code{font-family:${FONT.mono};font-weight:700;letter-spacing:.08em}`,
  `form{margin:0}`,
  `label{display:block;margin:1.5rem 0 .5rem;color:var(--strong);font-size:.875rem;line-height:1.25rem;font-weight:700}`,
  `input[type=text]{display:block;width:100%;min-height:44px;padding:0 .75rem;margin:0 0 1rem;border:1px solid var(--edge);border-radius:6px;background:var(--sunken);color:var(--strong);font-family:${FONT.mono};font-size:1.25rem;letter-spacing:.08em;text-transform:uppercase}`,
  `input[type=text]::placeholder{color:var(--muted);opacity:1}`,
  `.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 1.25rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--on-accent);font:inherit;font-weight:700;text-decoration:none;cursor:pointer}`,
  `.actions{margin:1.5rem 0 0}`,
  `a{color:var(--accent-fg)}`,
  `:focus-visible{outline:2px solid var(--focus);outline-offset:2px}`,
  `@media (max-width: 30rem){.card{padding:1.5rem}}`,
].join("");

let styleSource: string | null = null;

/** The `'sha256-…'` source expression that allows `BRAND_PAGE_CSS`, computed once. */
export function brandPageStyleSource(): string {
  styleSource ??= `'sha256-${createHash("sha256").update(BRAND_PAGE_CSS, "utf8").digest("base64")}'`;
  return styleSource;
}

// ── The document ─────────────────────────────────────────────────────────────────────────────

export interface BrandPageOptions {
  /** The page `<title>`, before " · Polaris Key". Plain text (escaped here). */
  title: string;
  /** The `<h1>`. Plain text (escaped here). */
  heading: string;
  /** A short line above the heading (the product, the surface). Plain text. */
  eyebrow?: string;
  /** The card's body below the heading: TRUSTED markup built by the caller, every value escaped. */
  body?: string;
}

let lockup: string | null = null;

/**
 * A branded page: the Polaris Key lockup (80 px tall, so its glyph is the display cut at 48 px,
 * BRAND §1.3-1.4) above one card. Built on first use, so a brand template this shell cannot
 * theme fails that request rather than the Worker's module load.
 */
export function renderBrandPage(opts: BrandPageOptions): string {
  lockup ??= themedLockup("key", "horizontal", 80, "lockup");
  const dark = THEME_TOKENS.dark.surface.page;
  const light = THEME_TOKENS.light.surface.page;
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(opts.title)} · Polaris Key</title>`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<link rel="icon" type="image/svg+xml" href="${BRAND_WEB_KEY_PATH}/favicon.svg">`,
    `<style>${BRAND_PAGE_CSS}</style>`,
    `</head>`,
    `<body>`,
    `<main>`,
    `<div class="brand">${lockup}</div>`,
    `<div class="card">`,
    opts.eyebrow ? `<p class="eyebrow">${escapeHtml(opts.eyebrow)}</p>` : "",
    `<h1>${escapeHtml(opts.heading)}</h1>`,
    opts.body ?? "",
    `</div>`,
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}
