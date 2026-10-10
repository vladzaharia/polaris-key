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
import { lockupMetrics, markParts } from "@polaris-key/brand/svg";
import { escapeHtml } from "./html.js";

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

/**
 * The Pinned K alone, themed by the page's stylesheet like `themedLockup`: the mark the
 * console's `Logo` draws beside its "Polaris Key" text (the display cut at 48 px, no bit).
 * Decorative: the brand block's visible name says it.
 */
export function themedMark(size: number, className: string): string {
  const m = markParts({ kind: "key", size, theme: "dark", bit: "none" });
  const paths = m.parts
    .map((p) => {
      if (p.role === "gold")
        throw new Error("brand: the default mark has no bit");
      return `<path class="${ROLE_CLASS[p.role]}" d="${p.d}"/>`;
    })
    .join("");
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${m.grid} ${m.grid}" aria-hidden="true" focusable="false">${paths}</svg>`;
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

/**
 * The brand's variable faces (latin subset): Rubik (wght 300–900) for UI text and JetBrains Mono
 * (wght 400–600) for codes, UI-KITS.md §2.1. `font-synthesis: none` keeps a browser from faking a
 * weight the face does not carry.
 */
function fontFace(family: string, weights: string, file: string): string {
  return `@font-face{font-family:"${family}";font-style:normal;font-weight:${weights};font-display:swap;src:url("${BRAND_FONT_PATH}/${file}") format("woff2")}`;
}

/**
 * The shell's one stylesheet. Constant per build, so its SHA-256 in the policy is constant too.
 */
export const BRAND_PAGE_CSS = [
  fontFace("Rubik", "300 900", "rubik-var-latin.woff2"),
  fontFace("JetBrains Mono", "400 600", "jetbrains-mono-var-latin.woff2"),
  `:root{${palette("dark")}}`,
  `@media (prefers-color-scheme: light){:root{${palette("light")}}}`,
  `*{box-sizing:border-box}`,
  `html{background:var(--page)}`,
  `body{margin:0;min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:3rem 1rem;background:var(--page);color:var(--text);font-family:${FONT.sans};font-synthesis:none;font-size:1rem;line-height:1.5;-webkit-text-size-adjust:100%;text-rendering:optimizeLegibility}`,
  `main{width:100%;max-width:28rem}`,
  // The console sign-in look (shared with the customer portal's login card and the console's
  // own boot screen): the brand block centred over one card, brand type, generous spacing. The
  // block is the console `Logo`'s, measure for measure: the 48 px mark, a 12 px gap, "Polaris
  // Key" in bold at 16 px and the surface ("console", "account") as a small uppercase label.
  `.brand{display:flex;justify-content:center;align-items:center;gap:.75rem;margin:0 0 2rem;color:var(--strong)}`,
  `.brand svg{display:block;flex:none}`,
  `.wordmark{display:flex;align-items:baseline;gap:.375rem;font-size:1rem;line-height:1.5rem;font-weight:700;letter-spacing:-.025em}`,
  `.surface{color:var(--muted);font-size:.75rem;line-height:1rem;font-weight:400;letter-spacing:.05em;text-transform:uppercase}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
  `.card{padding:2rem;border:1px solid var(--rule);border-radius:8px;background:var(--raised);box-shadow:0 1px 2px rgb(0 0 0 / .12)}`,
  `.eyebrow{margin:0 0 .5rem;color:var(--muted);font-size:.75rem;line-height:1rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}`,
  `h1{margin:0 0 .5rem;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:700;letter-spacing:-.01em}`,
  `h1+p{color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
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
  // The console's md Button (BootScreen's Retry): 36 px, 14 px regular weight, one accent fill.
  `.button{display:flex;width:100%;align-items:center;justify-content:center;min-height:2.25rem;padding:0 1rem;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:.875rem;line-height:1.25rem;font-weight:400;text-decoration:none;cursor:pointer}`,
  `.button:hover{filter:brightness(1.1)}`,
  `.actions{margin:1.5rem 0 0}`,
  // The secondary and destructive buttons, and a vertical button stack (the license chooser).
  `.button.secondary{border-color:var(--edge);background:transparent;color:var(--strong)}`,
  `.button.danger{border-color:var(--danger-edge);background:var(--danger-subtle);color:var(--strong)}`,
  `.stack{display:grid;gap:.5rem}`,
  `.small{font-size:.875rem;line-height:1.25rem}`,
  `.notice{margin:0 0 1rem;padding:.75rem 1rem;border:1px solid var(--rule);border-radius:6px;background:var(--sunken);color:var(--strong)}`,
  `.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}`,
  // The license chooser's rows (I-26): radio cards, the console's RadioCards look.
  `fieldset.choices{margin:0;padding:0;border:0;min-width:0}`,
  `ul.choices{display:grid;gap:.5rem;margin:0;padding:0;list-style:none}`,
  `.choice{display:flex;gap:.75rem;align-items:flex-start;margin:0;padding:.75rem 1rem;border:1px solid var(--edge);border-radius:6px;background:var(--sunken);color:var(--text);font-size:1rem;font-weight:400;cursor:pointer}`,
  `.choice:has(input:checked){border-color:var(--accent);background:var(--accent-subtle)}`,
  `.choice input{flex:none;width:1rem;height:1rem;margin:.25rem 0 0;accent-color:var(--accent)}`,
  `.choice.is-disabled{cursor:default;border-style:dashed}`,
  // A full or blocked row keeps body-text contrast: only the missing radio marks it (SIGN-IN.md
  // §3.14).
  `.choice.compact{padding:.5rem .75rem;margin:.5rem 0 0}`,
  `.choice-body{display:grid;gap:.125rem;min-width:0}`,
  `.choice-title{display:flex;flex-wrap:wrap;gap:.375rem;align-items:center;color:var(--strong);font-weight:700}`,
  `.choice-meta{color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.choice-seats{min-width:0;color:var(--strong);font-size:.875rem;line-height:1.25rem;font-weight:400}`,
  `.choice-title.tiered{flex-wrap:nowrap;align-items:baseline}`,
  `.choice-title.tiered .tag{flex:none}`,
  `.hint{display:block;color:var(--muted);font-size:.75rem;line-height:1rem}`,
  `.choice-note{color:var(--danger);font-size:.875rem;line-height:1.25rem}`,
  `.tag{padding:0 .375rem;border:1px solid var(--rule);border-radius:4px;color:var(--muted);font-size:.75rem;line-height:1.125rem;font-weight:400}`,
  `details.replace{margin:.5rem 0 0;padding:0 0 0 1rem;border-left:2px solid var(--rule)}`,
  `details.replace summary{color:var(--accent-fg);font-size:.875rem;line-height:1.25rem;cursor:pointer}`,
  `details.replace .button{margin:.75rem 0 0}`,
  `ul.choices>li>p.small{margin:.5rem 0 0 1rem}`,
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
  /**
   * The surface beside the wordmark, as the console's `Logo` labels it ("console", "account",
   * "device"). Plain text (escaped here); drawn uppercase by the stylesheet.
   */
  surface?: string;
  /** A short line above the heading (a product name). Plain text. */
  eyebrow?: string;
  /** The card's body below the heading: TRUSTED markup built by the caller, every value escaped. */
  body?: string;
}

let mark: string | null = null;

/**
 * A branded page: the console's brand block (the Pinned K at 48 px, the display cut, BRAND
 * §1.3-1.4, beside "Polaris Key" and the surface label) above one card, so a Worker-served
 * sign-in error reads as the same design as the console's boot screen and the portal's login.
 * Built on first use, so a brand geometry this shell cannot theme fails that request rather
 * than the Worker's module load.
 */
export function renderBrandPage(opts: BrandPageOptions): string {
  mark ??= themedMark(48, "mark");
  const surface = opts.surface
    ? `<span class="surface">${escapeHtml(opts.surface)}</span>`
    : "";
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
    `<div class="brand" role="img" aria-label="Polaris Key${opts.surface ? ` ${escapeHtml(opts.surface)}` : ""}">${mark}<span class="wordmark" aria-hidden="true">Polaris&nbsp;Key${surface}</span></div>`,
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
