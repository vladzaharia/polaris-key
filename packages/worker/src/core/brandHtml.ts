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
 * ── Polaris Locker (LK-07; plans/LK-00.md §7.12, A3 §14.2) ──────────────────────────────────
 *
 * The shell draws the Polaris Locker identity by default: `data-brand="locker"` on `<html>`, the
 * Locker lockup, the Locker favicon and title suffix, and neutral-ink actions and links with coral
 * as identity only (D9a). Every page the Worker answers to a customer is one. The console's own
 * pages (`console/auth.ts`) pass `brand: "key"`: the Pinned K, the Polaris Key wordmark, the
 * violet accent. Each has its own stylesheet and SHA-256: the Locker one is the Key one plus a
 * constant tail (`BRAND_PAGE_CSS_LOCKER`).
 *
 * The bytes host never uses this shell: its pages stay on the system stack with no font source
 * at all (`bytesLanding.ts`, BRAND.md §8).
 */

import { createHash } from "node:crypto";
import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import {
  LOCKER_LOCKUP_PALETTES,
  lockupMetrics,
  markParts,
} from "@polaris-key/brand/svg";
import { escapeHtml } from "../platform/html.js";

/** Where the admin build emits the brand fonts and the Pinned K web identity. */
export const BRAND_FONT_PATH = "/assets/branding/fonts";
export const BRAND_WEB_KEY_PATH = "/assets/branding/key";
/** The Polaris Locker favicon set, emitted next to it (`packages/admin/vite.config.ts`). */
export const BRAND_WEB_LOCKER_PATH = "/assets/branding/locker";

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
  kind: "key" | "delivery" | "locker",
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
  // Key" in bold at 20 px (the console Logo's 16 px read small beside the 48 px mark) and the surface ("console", "account") as a small uppercase label.
  `.brand{display:flex;justify-content:center;align-items:center;gap:.75rem;margin:0 0 2rem;color:var(--strong)}`,
  `.brand svg{display:block;flex:none}`,
  `.wordmark{display:flex;align-items:baseline;gap:.375rem;font-size:1.25rem;line-height:1.75rem;font-weight:700;letter-spacing:-.025em}`,
  `.surface{color:var(--muted);font-size:.75rem;line-height:1rem;font-weight:400;letter-spacing:.05em;text-transform:uppercase}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
  // The app the page is about (a refusal names it): its icon and name above the card, as the
  // hosted card's header strip does.
  `.app{display:flex;justify-content:center;align-items:center;gap:.75rem;margin:0 0 1rem;color:var(--strong);font-size:1.125rem;line-height:1.5rem;font-weight:700;overflow-wrap:anywhere}`,
  `.app img{display:block;flex:none;width:40px;height:40px;border-radius:9px;object-fit:cover}`,
  `.card>:last-child{margin-bottom:0}`,
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
  // The TV variant (`variant: "tv"`): read from a sofa, typed with a remote. Larger type and
  // targets, the same flow.
  `.tv main{max-width:48rem}`,
  `.tv .card{padding:3rem}`,
  `.tv h1{font-size:2.5rem;line-height:3rem}`,
  `.tv h1+p,.tv .alert{font-size:1.5rem;line-height:2rem}`,
  `.tv label{font-size:1.5rem;line-height:2rem}`,
  `.tv input[type=text]{min-height:5rem;font-size:2.5rem}`,
  `.tv .button{min-height:4.5rem;font-size:1.75rem;line-height:2rem}`,
  `@media (max-width: 30rem){.tv .card{padding:1.5rem}.tv h1{font-size:2rem;line-height:2.5rem}.tv input[type=text]{font-size:1.75rem}}`,
].join("");

/** The Locker identity's palette per theme: the lockup's three inks, and the neutral-ink action. */
function lockerPalette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  const ink = LOCKER_LOCKUP_PALETTES[theme];
  return [
    `--mb:${ink.body}`,
    `--ms:${ink.star}`,
    `--mt:${ink.text}`,
    `--accent:${t.action.fill}`,
    `--accent-fg:${t.text.strong}`,
    `--on-accent:${t.action.on}`,
    `--accent-subtle:${t.surface.sunken}`,
    `--focus:${t.text.strong}`,
  ].join(";");
}

/**
 * What a Locker page adds to `BRAND_PAGE_CSS` (a build constant, so its hash is too): the Locker
 * inks, and D9a: coral is identity only, so actions, focus and link text are neutral ink and the
 * link underline (2 px) carries the coral.
 */
const LOCKER_PAGE_CSS_TAIL = [
  `:root[data-brand=locker]{${lockerPalette("dark")}}`,
  `@media (prefers-color-scheme: light){:root[data-brand=locker]{${lockerPalette("light")}}}`,
  `[data-brand=locker] a:not(.button){color:var(--strong);text-decoration:underline;text-decoration-color:var(--mb);text-decoration-thickness:2px;text-underline-offset:.2em}`,
  `[data-brand=locker] .button{text-decoration:none}`,
  // ── The AuthCard's Worker twin (`renderAuthCard`; packages/admin/src/ui/auth/AuthCard.tsx is the
  // React original): the lockup above, one 28.5 rem card (22 px radius) with an optional header,
  // the step body (one primary), and an optional footer. Phones: the card goes edge to edge
  // under a 56 px lockup row.
  `[data-brand=locker] body{display:block;min-height:100dvh;padding:clamp(1.5rem,7vh,3.5rem) 1rem 3rem}`,
  `.ac-brand{display:flex;justify-content:center;margin:0 0 1.5rem;color:var(--strong)}`,
  `.ac-brand svg{display:block;max-width:100%}`,
  `main.ac{display:block;width:100%;max-width:28.5rem;min-width:0;margin:0 auto;overflow:hidden;border:1px solid var(--rule);border-radius:1.375rem;background:var(--raised);box-shadow:0 8px 24px rgb(0 0 0 / .18)}`,
  `.ac-head{display:flex;gap:1rem;align-items:center;min-width:0;padding:1rem 1.75rem;border-bottom:1px solid var(--rule)}`,
  `.ac-head img,.ac-mono{display:block;flex:none;width:48px;height:48px;border-radius:11px;object-fit:cover}`,
  `.ac-mono{display:grid;place-items:center;background:var(--sunken);border:1px solid var(--rule);color:var(--strong);font-weight:700}`,
  `.ac-head-text{display:grid;min-width:0;overflow-wrap:anywhere}`,
  `.ac-head-text p{margin:0}`,
  `.ac-head-title{color:var(--strong);font-size:1rem;line-height:1.5rem}`,
  `.ac-head-sub{color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.ac-body{display:grid;gap:1.25rem;min-width:0;padding:2rem 1.75rem;overflow-wrap:anywhere}`,
  `.ac-body>*{margin:0;min-width:0}`,
  `.ac-body h1{font-size:1.5rem;line-height:2rem;letter-spacing:0}`,
  `.ac-body h1+p{font-size:.9375rem;line-height:1.375rem}`,
  `.ac-body label{margin:0 0 .5rem}`,
  `.ac-body .actions{margin:0}`,
  `.ac-body .actions.stack,.ac-body .stack{gap:.5rem}`,
  `.ac-foot{display:flex;gap:.75rem;align-items:flex-start;padding:1rem 1.75rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.875rem;line-height:1.25rem;overflow-wrap:anywhere}`,
  `.ac-foot svg{margin-top:.125rem}`,
  `.ic{flex:none;width:1.25rem;height:1.25rem;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}`,
  `.ic.sm{width:1rem;height:1rem}`,
  // Buttons: 48 px, ink fill, one primary per step. `.link` is the quiet third action.
  `[data-brand=locker] .button{min-height:3rem;gap:.5rem;border-radius:.5rem;font-size:1rem;line-height:1.5rem;font-weight:600}`,
  `[data-brand=locker] .button.secondary{border-color:var(--edge);background:transparent;color:var(--strong)}`,
  `[data-brand=locker] .button.link{border-color:transparent;background:transparent;color:var(--strong);min-height:2.75rem}`,
  `[data-brand=locker] .button.link:hover{text-decoration:underline;text-decoration-color:var(--mb);text-decoration-thickness:2px;text-underline-offset:.2em;filter:none}`,
  `.ac-body form{display:grid;gap:1.25rem;min-width:0}`,
  // A neutral callout (DL6: a refusal is information, not an alarm) and the one-line note.
  `.callout{display:flex;gap:.75rem;align-items:flex-start;padding:1rem;border:1px solid var(--rule);border-radius:.75rem;background:var(--sunken)}`,
  `.callout>.ic{margin-top:.125rem;color:var(--muted)}`,
  `.callout-text{display:grid;gap:.125rem;min-width:0}`,
  `.callout-text p{margin:0;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.callout-text .callout-title{color:var(--strong);font-size:.9375rem;line-height:1.375rem;font-weight:600}`,
  `.note{display:flex;gap:.5rem;align-items:flex-start;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.note>.ic{margin-top:.125rem}`,
  // The code field: big mono caps, centred; its error sits under it, never above the form.
  `.field{display:grid;gap:.5rem;min-width:0}`,
  `.field label,.field input{margin:0}`,
  `.ac-body input[type=text]{margin:0;min-height:3.5rem;text-align:center;font-size:1.5rem}`,
  `.ac-body input[type=text][aria-invalid=true]{border-color:var(--danger-edge)}`,
  `.field-err{display:flex;gap:.5rem;align-items:flex-start;color:var(--danger);font-size:.875rem;line-height:1.25rem}`,
  `.field-err .ic{margin-top:.125rem}`,
  `.ac-body dl{margin:0}`,
  // The licence chooser: the selected row is a neutral 7 % fill with a coral 3 px marker (D9a);
  // a link inside a row is a 44 px target.
  `[data-brand=locker] .choice:has(input:checked){border-color:var(--edge);background:color-mix(in srgb,var(--strong) 7%,var(--sunken));box-shadow:inset 3px 0 0 var(--mb)}`,
  `@media (forced-colors: active){[data-brand=locker] .choice:has(input:checked){border-color:Highlight;border-left-width:3px}}`,
  `[data-brand=locker] ul.choices a{display:inline-flex;align-items:center;min-height:2.75rem}`,
  `[data-brand=locker] details.replace summary{display:flex;align-items:center;min-height:2.75rem}`,
  `@media (max-width: 30rem){[data-brand=locker] body{padding:0 0 2rem}.ac-brand{height:3.5rem;align-items:center;margin:0;border-bottom:1px solid var(--rule)}main.ac{max-width:none;border-width:0 0 1px;border-radius:0;box-shadow:none;background:var(--page)}.ac-head,.ac-body,.ac-foot{padding-left:1.25rem;padding-right:1.25rem}.ac-body{padding-top:1.5rem;padding-bottom:1.5rem}}`,
  // The TV variant (`/tv`): read from a sofa, typed with a remote. Large type and targets, the
  // same card.
  `.tv main.ac{max-width:46rem}`,
  `.tv .ac-body{gap:1.75rem;padding:3rem}`,
  `.tv .ac-body h1{font-size:2.5rem;line-height:3rem}`,
  `.tv .ac-body h1+p,.tv .note,.tv .callout-text p,.tv .field-err,.tv .ac-foot{font-size:1.5rem;line-height:2rem}`,
  `.tv .callout-text .callout-title{font-size:1.75rem;line-height:2.25rem}`,
  `.tv .ac-body label{font-size:1.5rem;line-height:2rem}`,
  `.tv .ac-body input[type=text]{min-height:5.5rem;font-size:3rem}`,
  `[data-brand=locker] .tv .button{min-height:4.5rem;font-size:1.75rem;line-height:2rem}`,
  `.tv .ic{width:2rem;height:2rem}`,
  `.tv .ac-foot,.tv .ac-head{padding-left:3rem;padding-right:3rem}`,
  `@media (max-width: 30rem){.tv .ac-body{padding:1.5rem}.tv .ac-body h1{font-size:2rem;line-height:2.5rem}.tv .ac-body input[type=text]{font-size:2rem}.tv .ac-foot,.tv .ac-head{padding-left:1.25rem;padding-right:1.25rem}}`,
].join("");

/** The stylesheet of a Locker page: `BRAND_PAGE_CSS` and its tail. */
export const BRAND_PAGE_CSS_LOCKER = BRAND_PAGE_CSS + LOCKER_PAGE_CSS_TAIL;

export type BrandPageBrand = "key" | "locker";

const styleSources = new Map<string, string>();

/**
 * The `'sha256-…'` source expression that allows the page stylesheet (`BRAND_PAGE_CSS_LOCKER` for
 * `"locker"`, the default; `BRAND_PAGE_CSS` for `"key"`), computed once.
 */
export function brandPageStyleSource(brand: BrandPageBrand = "locker"): string {
  const key = brand;
  let v = styleSources.get(key);
  if (v === undefined) {
    const css = brand === "locker" ? BRAND_PAGE_CSS_LOCKER : BRAND_PAGE_CSS;
    v = `'sha256-${createHash("sha256").update(css, "utf8").digest("base64")}'`;
    styleSources.set(key, v);
  }
  return v;
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
  /** The app the page is about: its name and, when it has one, its hosted icon (an image-host URL). */
  app?: { name: string; iconUrl?: string | null };
  /** The card's body below the heading: TRUSTED markup built by the caller, every value escaped. */
  body?: string;
  /** `tv`: larger type and targets for a TV browser (`/tv`). */
  variant?: "tv";
  /** `key`: the Polaris Key console identity; the default is Polaris Locker (see the header). */
  brand?: BrandPageBrand;
  /** Locker only: TRUSTED markup for the card's header slot (`appHeader`). Wins over `app`. */
  header?: string;
  /** Locker only: the card's footer line, plain text beside an icon. */
  footer?: { icon: IconName; text: string };
}

export type AuthCardOptions = Omit<
  BrandPageOptions,
  "brand" | "surface" | "eyebrow"
>;

// ── Pieces the pages share (the AuthCard's slots as HTML) ───────────────────────────────────

const ICON_PATHS = {
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  "x-circle":
    '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  "check-circle": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  monitor:
    '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
} as const;
export type IconName = keyof typeof ICON_PATHS;

/** A decorative inline icon (stroke follows the text colour). */
export function icon(name: IconName, small = false): string {
  return `<svg class="ic${small ? " sm" : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

/**
 * A neutral callout (DL6): an icon, a bold line and an optional detail. Plain text in, escaped
 * here. `role` is for a state the person must hear when the page loads.
 */
export function callout(
  name: IconName,
  title: string,
  detail?: string,
): string {
  return `<div class="callout">${icon(name)}<div class="callout-text"><p class="callout-title">${escapeHtml(title)}</p>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</div></div>`;
}

/** The one-line note under a form: an icon and muted text. */
export function note(name: IconName, text: string): string {
  return `<p class="note">${icon(name, true)}<span>${escapeHtml(text)}</span></p>`;
}

/**
 * The card's app header strip: the app's icon (or its initial) and "<name> <action>" over one
 * muted line. `title` is plain text; `bold` is the leading part drawn strong.
 */
export function appHeader(opts: {
  name: string;
  iconUrl?: string | null;
  /** What follows the name in the title line ("wants you to sign in"); none: the name alone. */
  action?: string;
  /** The muted line below (developer, device); plain text. */
  sub?: string;
}): string {
  const art = opts.iconUrl
    ? `<img src="${escapeHtml(opts.iconUrl)}" alt="" width="48" height="48">`
    : `<span class="ac-mono" aria-hidden="true">${escapeHtml([...opts.name][0]?.toUpperCase() ?? "")}</span>`;
  return `<div class="ac-head">${art}<div class="ac-head-text"><p class="ac-head-title"><strong>${escapeHtml(opts.name)}</strong>${opts.action ? ` ${escapeHtml(opts.action)}` : ""}</p>${opts.sub ? `<p class="ac-head-sub">${escapeHtml(opts.sub)}</p>` : ""}</div></div>`;
}

let mark: string | null = null;
let lockerLockup: string | null = null;

/**
 * The brand block above the card. `surface` is the already-escaped surface label, or "". Key:
 * the Pinned K and "Polaris Key" with the label beside it. Locker: the Locker lockup (its own
 * wordmark) with the label beside it.
 */
function brandBlock(
  brand: BrandPageBrand | undefined,
  surface: string,
): string {
  const label = surface ? `<span class="surface">${surface}</span>` : "";
  const aria = surface ? ` ${surface}` : "";
  if (brand === "locker") {
    lockerLockup ??= themedLockup("locker", "horizontal", 48, "mark");
    // The Locker lockup is its own wordmark: no surface label beside it.
    return `<div class="brand" role="img" aria-label="Polaris Locker${aria}">${lockerLockup}</div>`;
  }
  mark ??= themedMark(48, "mark");
  return `<div class="brand" role="img" aria-label="Polaris Key${aria}">${mark}<span class="wordmark" aria-hidden="true">Polaris&nbsp;Key${label}</span></div>`;
}

/**
 * A branded page: the console's brand block (the Pinned K at 48 px, the display cut, BRAND
 * §1.3-1.4, beside "Polaris Key" and the surface label) above one card, so a Worker-served
 * sign-in error reads as the same design as the console's boot screen and the portal's login.
 * Built on first use, so a brand geometry this shell cannot theme fails that request rather
 * than the Worker's module load.
 */
export function renderBrandPage(opts: BrandPageOptions): string {
  if (opts.brand !== "key") return renderAuthCard(opts);
  const locker = false;
  const brandName = locker ? "Polaris Locker" : "Polaris Key";
  const app = opts.app
    ? `<div class="app">${
        opts.app.iconUrl
          ? `<img src="${escapeHtml(opts.app.iconUrl)}" alt="" width="40" height="40">`
          : ""
      }<span>${escapeHtml(opts.app.name)}</span></div>`
    : "";
  const dark = THEME_TOKENS.dark.surface.page;
  const light = THEME_TOKENS.light.surface.page;
  return [
    `<!doctype html>`,
    locker ? `<html lang="en" data-brand="locker">` : `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(opts.title)} · ${brandName}</title>`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<link rel="icon" type="image/svg+xml" href="${locker ? BRAND_WEB_LOCKER_PATH : BRAND_WEB_KEY_PATH}/favicon.svg">`,
    `<style>${locker ? BRAND_PAGE_CSS_LOCKER : BRAND_PAGE_CSS}</style>`,
    `</head>`,
    opts.variant === "tv" ? `<body class="tv">` : `<body>`,
    `<main>`,
    brandBlock(
      opts.brand ?? "locker",
      opts.surface ? escapeHtml(opts.surface) : "",
    ),
    app,
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

/**
 * The AuthCard's Worker twin: a Polaris Locker page (no script, no `style=` attribute) with the
 * same slots as `packages/admin/src/ui/auth/AuthCard.tsx`: the lockup, then one card with an
 * optional header (`header`, or the app's strip from `app`), the step (`heading` and `body`) and
 * an optional footer. Every Worker page a customer reaches is one. `body` and `header` are
 * TRUSTED markup built with the helpers above, every value escaped.
 */
export function renderAuthCard(opts: AuthCardOptions): string {
  lockerLockup ??= themedLockup("locker", "horizontal", 48, "mark");
  const header =
    opts.header ??
    (opts.app
      ? appHeader({ name: opts.app.name, iconUrl: opts.app.iconUrl })
      : "");
  const dark = THEME_TOKENS.dark.surface.page;
  const light = THEME_TOKENS.light.surface.page;
  return [
    `<!doctype html>`,
    `<html lang="en" data-brand="locker">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(opts.title)} · Polaris Locker</title>`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<link rel="icon" type="image/svg+xml" href="${BRAND_WEB_LOCKER_PATH}/favicon.svg">`,
    `<style>${BRAND_PAGE_CSS_LOCKER}</style>`,
    `</head>`,
    opts.variant === "tv" ? `<body class="tv">` : `<body>`,
    `<div class="ac-brand" role="img" aria-label="Polaris Locker">${lockerLockup}</div>`,
    `<main class="ac">`,
    header,
    `<div class="ac-body">`,
    `<h1>${escapeHtml(opts.heading)}</h1>`,
    opts.body ?? "",
    `</div>`,
    opts.footer
      ? `<footer class="ac-foot">${icon(opts.footer.icon, true)}<span>${escapeHtml(opts.footer.text)}</span></footer>`
      : "",
    `</main>`,
    `</body>`,
    `</html>`,
    ``,
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}
