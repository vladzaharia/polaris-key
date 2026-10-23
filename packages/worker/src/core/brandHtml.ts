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
 * pages (`console/auth.ts`) pass `brand: "key"`: the Polaris Key compact lockup (outlined; never live
 * text), the violet accent. Each has its own stylesheet and SHA-256: the Locker one is the Key one plus a
 * constant tail (`BRAND_PAGE_CSS_LOCKER`).
 *
 * The bytes host never uses this shell: its pages stay on the system stack with no font source
 * at all (`bytesLanding.ts`, BRAND.md §8).
 */

import { createHash } from "node:crypto";
import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import { LOCKER_LOCKUP_PALETTES, lockupMetrics } from "@polaris-key/brand/svg";
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
 * a brand change this code must not follow silently, so it throws (the tests fail). `trim`
 * crops the horizontal canvas to the glyph and wordmark (BRAND §1.4's trimmed lockup, and
 * `LOCKER_TRIM`), so `height` is the cropped canvas's height and the host supplies the clear space.
 */
export function themedLockup(
  kind: "key" | "delivery" | "locker",
  layout: "horizontal" | "compact",
  height: number,
  className: string,
  trim = false,
): string {
  const m = lockupMetrics({ kind, layout, height, trim });
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
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" width="${w}" height="${height}" viewBox="${m.view.x} ${m.view.y} ${m.view.width} ${m.view.height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>`;
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
  // block is the kit's compact outlined Key lockup (the name is never live text, BRAND.md Don'ts) and the
  // surface ("console", "account") as a small uppercase label beside it.
  `.brand{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:.5rem .75rem;margin:0 0 2rem;color:var(--strong)}`,
  `.brand svg{display:block;flex:none;max-width:100%}`,
  `.surface{color:var(--muted);font-size:.75rem;line-height:1rem;font-weight:400;letter-spacing:.05em;text-transform:uppercase}`,
  `.mb{fill:var(--mb)}.ms{fill:var(--ms)}.mt{fill:var(--mt)}`,
  // The app the page is about (a refusal names it): its icon and name above the card, as the
  // hosted card's header strip does.
  `.app{display:flex;justify-content:center;align-items:center;gap:.75rem;margin:0 0 1rem;color:var(--strong);font-size:1.125rem;line-height:1.5rem;font-weight:600;overflow-wrap:anywhere}`,
  `.app img{display:block;flex:none;width:40px;height:40px;border-radius:9px;object-fit:cover}`,
  `.card>:last-child{margin-bottom:0}`,
  `.card{padding:2rem;border:1px solid var(--rule);border-radius:8px;background:var(--raised);box-shadow:0 1px 2px rgb(0 0 0 / .12)}`,
  `.eyebrow{margin:0 0 .5rem;color:var(--muted);font-size:.75rem;line-height:1rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase}`,
  `h1{margin:0 0 .5rem;color:var(--strong);font-size:1.25rem;line-height:1.75rem;font-weight:600;letter-spacing:-.01em}`,
  `h1+p{color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `p{margin:0 0 1rem}`,
  `.muted{color:var(--muted)}`,
  `.alert{margin:0 0 1rem;padding:.75rem 1rem;border:1px solid var(--danger-edge);border-radius:6px;background:var(--danger-subtle);color:var(--strong)}`,
  `dl{display:grid;grid-template-columns:6rem 1fr;gap:.5rem 1rem;margin:1.5rem 0;padding:1rem;border-radius:6px;background:var(--sunken)}`,
  `dt{color:var(--muted)}`,
  `dd{margin:0;color:var(--strong);overflow-wrap:anywhere}`,
  `.code{font-family:${FONT.mono};font-weight:600;letter-spacing:.08em;white-space:nowrap}`,
  `form{margin:0}`,
  `label{display:block;margin:1.5rem 0 .5rem;color:var(--strong);font-size:.875rem;line-height:1.25rem;font-weight:500}`,
  `input[type=text]{display:block;width:100%;min-height:44px;padding:0 .75rem;margin:0 0 1rem;border:1px solid var(--edge);border-radius:6px;background:var(--sunken);color:var(--strong);font-family:${FONT.mono};font-size:1.25rem;letter-spacing:.08em;text-transform:uppercase}`,
  `input[type=text]::placeholder{color:var(--muted);opacity:1}`,
  // The console's md Button (BootScreen's Retry): 36 px, 14 px regular weight, one accent fill.
  `.button{display:flex;width:100%;align-items:center;justify-content:center;min-height:2.25rem;padding:.5rem 1rem;text-align:center;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:var(--on-accent);font:inherit;font-size:.875rem;line-height:1.25rem;font-weight:400;text-decoration:none;cursor:pointer}`,
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
  `.choice-title{display:flex;flex-wrap:wrap;gap:.375rem;align-items:center;color:var(--strong);font-weight:600}`,
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
const AUTH_CARD_RULES = [
  `[data-brand=locker] a:not(.button){color:var(--strong);text-decoration:underline;text-decoration-color:var(--mb);text-decoration-thickness:2px;text-underline-offset:.2em}`,
  `[data-brand=locker] .button{text-decoration:none}`,
  // ── The AuthCard's Worker twin (`renderAuthCard`; packages/admin/src/ui/auth/AuthCard.tsx is the
  // React original): the lockup above, one 28.5 rem card (22 px radius) with an optional header,
  // the step body (one primary), and an optional footer. Phones: the card goes edge to edge
  // under a 56 px lockup row (36 px tall lockup, 196 px wide: the guide's 180 minimum).
  `[data-brand=locker] body{display:block;place-items:normal;min-height:100dvh;padding:clamp(1.5rem,7vh,3.5rem) 1rem 3rem}`,
  `.ac-brand{display:flex;justify-content:center;margin:0 0 1.5rem;color:var(--strong)}`,
  `.ac-brand svg{display:block;max-width:100%;height:auto}`,
  `main.ac{display:block;width:100%;max-width:28.5rem;min-width:0;margin:0 auto;overflow:hidden;border:1px solid var(--rule);border-radius:1.375rem;background:var(--raised);box-shadow:0 8px 24px rgb(0 0 0 / .18)}`,
  `.ac-head{display:flex;gap:1rem;align-items:center;min-width:0;padding:1rem 1.75rem;border-bottom:1px solid var(--rule)}`,
  `.ac-head img,.ac-mono{display:block;flex:none;width:48px;height:48px;border-radius:11px;object-fit:cover}`,
  `.ac-head-title strong{font-weight:600}`,
  `.ac-mono{display:grid;place-items:center;background:var(--sunken);border:1px solid var(--rule);color:var(--strong);font-weight:600}`,
  `.ac-head-text{display:grid;min-width:0;overflow-wrap:anywhere}`,
  `.ac-head-text p{margin:0}`,
  `.ac-head-title{color:var(--strong);font-size:1rem;line-height:1.5rem}`,
  `.ac-head-sub{color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.ac-dev{display:flex;gap:.375rem;align-items:center}`,
  `.ac-dev .ic{margin:0}`,
  `.ac-brand.quiet{opacity:.8}`,
  `.ac-passport{display:none}`,
  `.ac-body{display:grid;gap:1.25rem;min-width:0;padding:2rem 1.75rem;overflow-wrap:anywhere}`,
  `.ac-body>*{margin:0;min-width:0}`,
  `.ac-body h1{font-size:1.5rem;line-height:2rem;letter-spacing:0}`,
  `.ac-body h1+p{font-size:.9375rem;line-height:1.375rem}`,
  `.ac-body label{margin:0 0 .5rem}`,
  `.ac-body .actions{margin:0}`,
  `.ac-body .actions.stack,.ac-body .stack{gap:.5rem}`,
  `.ac-foot{display:flex;gap:.75rem;align-items:flex-start;padding:1rem 1.75rem;border-top:1px solid var(--rule);color:var(--muted);font-size:.875rem;line-height:1.25rem;overflow-wrap:anywhere}`,
  `.ac-foot svg{margin-top:.125rem}`,
  // Under the card: Help and Privacy, quiet, with 24 px targets.
  `.ac-links{display:flex;flex-wrap:wrap;justify-content:center;gap:.25rem 1.5rem;max-width:28.5rem;margin:1.25rem auto 0;padding:0 1.25rem}`,
  `.ac-links a+a{position:relative}`,
  `.ac-links a+a::before{content:"\\00b7";position:absolute;inset-inline-start:-1.0625rem;color:var(--muted)}`,
  `.ac-links a{display:inline-flex;align-items:center;min-height:1.5rem;padding:.125rem .25rem;font-size:.875rem;line-height:1.25rem}`,
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
  // The person row (SIGN-IN.md §3.6): initial avatar, name, email and the quiet "Not you?" action.
  `.person{display:flex;gap:.75rem;align-items:center;padding:.5rem .5rem .5rem .75rem;border:1px solid var(--rule);border-radius:.75rem;background:var(--sunken)}`,
  `.person .ac-mono{width:2.5rem;height:2.5rem;border-radius:50%}`,
  `.person-text{display:grid;min-width:0;flex:1;font-size:.875rem;line-height:1.25rem;color:var(--muted)}`,
  `.person-name{color:var(--strong);font-weight:600}`,
  `.person .quiet{flex:none;min-height:2.75rem;padding:0 .5rem;border:0;background:none;color:var(--strong);font:inherit;font-size:.875rem;text-decoration:underline;text-decoration-color:var(--mb);text-decoration-thickness:2px;text-underline-offset:.2em;cursor:pointer}`,
  `.note{display:flex;gap:.5rem;align-items:flex-start;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.note>.ic{margin-top:.125rem}`,
  // The code field: big mono caps, centred; its error sits under it, never above the form.
  `.field{display:grid;gap:.5rem;min-width:0}`,
  `.field label,.field input{margin:0}`,
  `.ac-body input[type=text]{margin:0;min-height:3.5rem;text-align:center;font-size:min(1.5rem,6vw);letter-spacing:.04em}`,
  `.ac-body input[type=text][aria-invalid=true]{border-color:var(--danger-edge)}`,
  `.field-err{display:flex;gap:.5rem;align-items:flex-start;color:var(--danger);font-size:.875rem;line-height:1.25rem}`,
  `.field-err .ic{margin-top:.125rem}`,
  `.ac-body dl{display:flex;flex-wrap:wrap;gap:.5rem 1rem;margin:0}`,
  `.ac-body dt{flex:0 0 6rem}`,
  `.ac-body dd{flex:1 1 calc(100% - 7rem);min-width:min(100%,12rem);overflow-wrap:break-word}`,
  `.ac-body h1:focus{outline:none}`,
  `@media (forced-colors: active){[data-brand=locker] .button:not(.secondary):not(.link){border:3px solid Highlight;background:ButtonFace;color:ButtonText}}`,
  // The licence chooser: the selected row is a neutral 7 % fill with a coral 3 px marker (D9a);
  // a link inside a row is a 44 px target.
  `[data-brand=locker] .choice:has(input:checked){border-color:var(--edge);background:color-mix(in srgb,var(--strong) 7%,var(--sunken));box-shadow:inset 3px 0 0 var(--mb)}`,
  `@media (forced-colors: active){[data-brand=locker] .choice:has(input:checked){border-color:Highlight;border-left-width:3px}}`,
  `[data-brand=locker] ul.choices a{display:inline-flex;align-items:center;min-height:2.75rem}`,
  `[data-brand=locker] details.replace summary{display:flex;align-items:center;min-height:2.75rem}`,
  `@media (max-width: 30rem){[data-brand=locker] body{padding:0 0 2rem}.ac-brand{height:3.5rem;align-items:center;margin:0;border-bottom:1px solid var(--rule)}main.ac{max-width:none;border-width:0 0 1px;border-radius:0;box-shadow:none;background:var(--page)}.ac-head,.ac-body,.ac-foot{padding-left:1.25rem;padding-right:1.25rem}.ac-body{padding-top:1.5rem;padding-bottom:1.5rem}}`,
  // The hosted passport (SIGN-IN.md "the product passport"): at 960 px and wider with a width to
  // height ratio of at least 1.2, and while the page has room for 46 rem (a container query on the
  // body, so rem follows the root font size and 200 % text stacks the strip), the app sits in a
  // neutral start pane beside the step. Identity at the top (art edge to edge, the 56 px icon
  // over its lower edge, name, developer), the receipt at the foot (the device line, then the
  // safety line): the pane never ends in a void. Narrower, taller or larger text: the strip.
  `body{container-type:inline-size}`,
  `@media (min-width: 60rem) and (min-aspect-ratio: 6/5){@container (min-width: 46rem){main.ac-wide{max-width:46rem;display:grid;grid-template-columns:minmax(0,17.5rem) minmax(0,1fr);grid-template-rows:1fr auto}main.ac-wide .ac-head{display:none}main.ac-wide .ac-passport{display:flex;flex-direction:column;grid-column:1;grid-row:1;min-width:0;border-right:1px solid var(--rule);background:var(--sunken);color:var(--muted)}main.ac-wide .ac-body{grid-column:2;grid-row:1 / 3;align-content:start}main.ac-wide .ac-foot{grid-column:1;grid-row:2;padding-inline:1.5rem;border-top:0;border-right:1px solid var(--rule);background:var(--sunken)}.ac-art{display:block;width:100%;aspect-ratio:16/10;max-height:40%;object-fit:cover;flex:none}.ac-passport>:not(.ac-art){margin-inline:1.5rem}.ac-passport>:first-child:not(.ac-art){margin-top:2rem}.ac-art+img,.ac-art+.ac-mono{margin-top:-1.75rem;box-shadow:0 0 0 4px var(--sunken)}.ac-passport>img:not(.ac-art),.ac-passport>.ac-mono{flex:none;width:56px;height:56px;border-radius:14px;background:var(--raised)}.ac-pass-text{display:grid;gap:.25rem;margin-top:1rem;overflow-wrap:anywhere}.ac-pass-text p{margin:0}.ac-pass-text .ac-head-title{font-size:1.125rem;line-height:1.5rem;text-wrap:balance}.ac-pass-where{margin-top:.25rem;padding:0 0 1rem;align-items:flex-start}.ac-pass-where .ic{margin-top:.125rem}.ac-passport.ac-noart{justify-content:center;align-items:center;text-align:center}.ac-passport.ac-noart>:first-child{margin-top:0}.ac-passport.ac-noart>img,.ac-passport.ac-noart>.ac-mono{width:96px;height:96px;border-radius:24px;font-size:2.5rem}.ac-passport.ac-noart .ac-pass-where{justify-content:center;align-items:center;padding-bottom:0}}}`,
  `@media (forced-colors: active){main.ac-wide .ac-passport,main.ac-wide .ac-foot{border-right-color:CanvasText;background:Canvas;color:CanvasText}}`,
  // The TV variant (`/tv`): read from a sofa, typed with a remote. Large type and targets, the
  // same card.
  `.tv main.ac{max-width:46rem}`,
  `.tv .ac-body{gap:1.75rem;padding:3rem}`,
  `.tv .ac-body h1{font-size:2.5rem;line-height:3rem}`,
  `.tv .ac-body h1+p,.tv .note,.tv .callout-text p,.tv .field-err,.tv .ac-foot{font-size:1.5rem;line-height:2rem}`,
  `.tv .callout-text .callout-title{font-size:1.75rem;line-height:2.25rem}`,
  `.tv .ac-body label{font-size:1.5rem;line-height:2rem}`,
  `.tv .ac-body input[type=text]{min-height:5.5rem;font-size:min(3rem,8vw)}`,
  `[data-brand=locker] .tv .button{min-height:4.5rem;font-size:1.75rem;line-height:2rem}`,
  `.tv .ic{width:2rem;height:2rem}`,
  // On a phone the lockup drops to the BRAND phone size (36 px) in the media query at the end of this list; this rule (more specific than the phone one in the Locker tail) is the TV size.
  `.tv .ac-brand svg{height:72px;width:auto}`,
  `.tv .ac-head img,.tv .ac-head .ac-mono{width:64px;height:64px}`,
  `.tv .ac-head-title{font-size:1.5rem;line-height:2rem}`,
  `.tv .ac-head-sub{font-size:1.25rem;line-height:1.75rem}`,
  `.tv .ac-head .ic,.tv .ac-dev .ic{width:1.5rem;height:1.5rem}`,
  `.tv .ac-foot,.tv .ac-head{padding-left:3rem;padding-right:3rem}`,
  `.tv .ac-body dl{font-size:1.5rem;line-height:2rem}`,
  `.tv .ac-body .small{font-size:1.25rem;line-height:1.75rem}`,
  `@media (max-width: 30rem){.tv .ac-body{padding:1.5rem}.tv .ac-body h1{font-size:2rem;line-height:2.5rem}.tv .ac-body input[type=text]{font-size:min(2rem,7vw)}.tv .ac-foot,.tv .ac-head{padding-left:1.25rem;padding-right:1.25rem}}`,
];

const LOCKER_PAGE_CSS_TAIL = [
  `:root[data-brand=locker]{${lockerPalette("dark")}}`,
  `@media (prefers-color-scheme: light){:root[data-brand=locker]{${lockerPalette("light")}}}`,
  ...AUTH_CARD_RULES,
  // Phones: the Locker lockup drops to 36 px in its 56 px bar. Only here, not in `AUTH_CARD_RULES`,
  // which the console card shares with its brand attribute swapped: the console card keeps its
  // compact Key lockup at the brand size (BRAND_LOCKUP_HEIGHT.key). `/tv`'s 72 px TV lockup drops
  // to the same 36 px, inside the gutter.
  `@media (max-width: 30rem){.ac-brand svg{height:36px;width:auto}.tv .ac-brand svg{height:36px;max-width:calc(100% - 2rem)}}`,
].join("");

/** The stylesheet of a Locker page: `BRAND_PAGE_CSS` and its tail. */
export const BRAND_PAGE_CSS_LOCKER = BRAND_PAGE_CSS + LOCKER_PAGE_CSS_TAIL;

/**
 * The console's card (SIGN-IN.md §3.12): the AuthCard's rules again under `data-brand=console`,
 * with the Pinned K's own inks (the violet stays the mark's, never the action's) and the same
 * neutral-ink action, focus and link text. One set of rules, two palettes: no fork.
 */
function consolePalette(theme: "dark" | "light"): string {
  const t = THEME_TOKENS[theme];
  return [
    `--accent:${t.action.fill}`,
    `--accent-fg:${t.text.strong}`,
    `--on-accent:${t.action.on}`,
    `--accent-subtle:${t.surface.sunken}`,
    `--focus:${t.text.strong}`,
  ].join(";");
}
const CONSOLE_PAGE_CSS_TAIL = [
  `:root[data-brand=console]{${consolePalette("dark")}}`,
  `@media (prefers-color-scheme: light){:root[data-brand=console]{${consolePalette("light")}}}`,
  ...AUTH_CARD_RULES.map((r) =>
    r.replaceAll("[data-brand=locker]", "[data-brand=console]"),
  ),
  // The brand row: the compact lockup, a hairline and "Console" (SIGN-IN.md §3.1).
  `.ac-brand>div{display:flex;align-items:center}`,
  // The known operator (D-S5), drawn as frame 13's pill, not as a field: it wraps so Change drops
  // to its own line under large text, and the address breaks at "@" and ".".
  `.ac-body .field-label{color:var(--strong);font-size:.875rem;line-height:1.25rem;font-weight:600}`,
  `.chip{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:center;min-width:0;min-height:3rem;padding:.25rem .5rem .25rem .75rem;border:1px solid var(--edge);border-radius:1.75rem;background:transparent;color:var(--strong)}`,
  `.chip .ac-mono{width:1.75rem;height:1.75rem;border-radius:50%;font-size:.75rem}`,
  `.chip-email{flex:1 1 10rem;min-width:0;overflow-wrap:break-word}`,
  `.chip-change{display:inline-flex;align-items:center;flex:none;min-height:2.75rem;padding:0 .5rem;font-size:.875rem;font-weight:600;color:var(--strong);text-decoration:underline;text-decoration-color:var(--mb);text-decoration-thickness:2px;text-underline-offset:.2em}`,
  `.chip-change:focus-visible{outline-offset:-2px}`,
  // The passkey button (ST-30c.6): hidden until the card's script finds WebAuthn; an "or" rule
  // above it; its refusal sits under it as text. No motion anywhere on the card.
  `.pk{display:grid;gap:1rem;min-width:0}`,
  `.pk[hidden]{display:none}`,
  `.pk .or{display:flex;gap:1rem;align-items:center;color:var(--muted);font-size:.875rem;line-height:1.25rem}`,
  `.pk .or::before,.pk .or::after{content:"";flex:1;height:1px;background:var(--rule)}`,
  `.pk .button[aria-disabled=true]{opacity:.6;cursor:progress}`,
  `.pk-err{margin:0;color:var(--danger);font-size:.875rem;line-height:1.25rem}`,
  `.pk-err:empty{display:none}`,
  // The links row has no separator dots here: a dot cannot be told from a link's name, and one
  // stranded at a wrap reads as a glitch. The gap separates them.
  `[data-brand=console] .ac-links a+a::before{content:none}`,
  // The lockup at frame 13's size: native 64 px (222 x 64) from 30 rem, in rem so it grows with
  // the text. On phones both stay in px (and capped by the width) so a scaled root font cannot clip
  // the row or make "Console" larger than the wordmark.
  `[data-brand=console] .ac-brand svg{width:13.875rem;height:4rem}`,
  `[data-brand=console] .ac-brand .ac-surface{font-size:1.25rem;line-height:1.75rem;font-weight:500}`,
  `@media (max-width: 30rem){[data-brand=console] .ac-brand svg{width:min(180px,52vw);height:auto}[data-brand=console] .ac-brand .ac-surface{font-size:16px;line-height:24px;font-weight:400}}`,
  `.ac-body input[type=email]{display:block;width:100%;min-height:3rem;padding:0 .75rem;border:1px solid var(--edge);border-radius:.5rem;background:var(--sunken);color:var(--strong);font:inherit}`,
  `.ac-body input[type=email]::placeholder{color:var(--muted);opacity:1}`,
  `.ac-body .fine{color:var(--muted);font-size:.875rem;line-height:1.25rem;overflow-wrap:anywhere}`,
  `.ac-brand .ac-surface{margin-left:.75rem;padding-left:.75rem;border-left:1px solid var(--edge);color:var(--muted);font-size:1rem;line-height:1.5rem}`,
  `@media (forced-colors: active){.ac-brand .ac-surface{color:CanvasText;border-color:CanvasText}}`,
  // On a tall window the card sits near the optical centre (about 40% from the top), not under
  // the top edge with half a screen empty below; the phone layout keeps its own padding.
  `@media (min-width: 30.0625rem) and (min-height: 44rem){[data-brand=console] body{padding-top:clamp(1.5rem,16vh,11rem)}}`,
].join("");

/** The stylesheet of a console page. */
export const BRAND_PAGE_CSS_CONSOLE = BRAND_PAGE_CSS + CONSOLE_PAGE_CSS_TAIL;

export type BrandPageBrand = "key" | "locker" | "console";

const styleSources = new Map<string, string>();

/**
 * The `'sha256-…'` source expression that allows the page stylesheet (`BRAND_PAGE_CSS_LOCKER` for
 * `"locker"`, the default; `BRAND_PAGE_CSS` for `"key"`), computed once.
 */
export function brandPageStyleSource(brand: BrandPageBrand = "locker"): string {
  const key = brand;
  let v = styleSources.get(key);
  if (v === undefined) {
    const css =
      brand === "locker"
        ? BRAND_PAGE_CSS_LOCKER
        : brand === "console"
          ? BRAND_PAGE_CSS_CONSOLE
          : BRAND_PAGE_CSS;
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
  /** Locker only: TRUSTED markup above the `<h1>` inside the card body (the person row, `personRow`). */
  preface?: string;
  /** Locker only: initial focus on the `<h1>` (`tabindex=-1`), so a carried-over Enter presses nothing. */
  focusHeading?: boolean;
  /** Locker only: the card's footer line, plain text beside an icon. */
  footer?: { icon: IconName; text: string };
  /**
   * The links under the card (Help, Privacy). Each `href` is a path on this host, written by the
   * page, never taken from a request. Polaris Locker pages get `LOCKER_CARD_LINKS` unless they
   * pass their own; `[]` shows none.
   */
  links?: readonly { label: string; href: string }[];
  /** The links landmark's name; "Help and privacy" unless the row holds more than that. */
  linksLabel?: string;
  /**
   * Locker only: the hosted passport (identity.device-confirm). At 960 px and wider in landscape
   * the app's art, icon, developer and device sit beside the step; narrower, `header` is the
   * strip. Not drawn for `variant: "tv"`.
   */
  passport?: AppFacts;
}

/** What a page may say about the app that is asking (display data; every value plain text). */
export interface AppFacts {
  name: string;
  iconUrl?: string | null;
  developer?: string | null;
  /** The device label the app named. */
  device?: string | null;
  /** What follows the name ("wants you to sign in"). */
  action?: string;
  /** The product's art (Core Presentation header), an image-host URL; none: icon and text only. */
  artUrl?: string | null;
}

export type AuthCardOptions = Omit<
  BrandPageOptions,
  "brand" | "surface" | "eyebrow"
> & {
  /** `console`: the Polaris Key Console card (the compact Key lockup and "Console"); default Locker. */
  brand?: "console";
};

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
  smartphone:
    '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  devices:
    '<path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8"/><path d="M10 19v-3.96 3.15"/><path d="M7 19h5"/><rect width="6" height="10" x="16" y="12" rx="2"/>',
  "arrow-right": '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
} as const;
export type IconName = keyof typeof ICON_PATHS;

/** The glyph for a device the app named: a phone when its label says phone, else a monitor. */
function deviceIcon(label: string): string {
  return icon(
    /\b(?:iphone|pixel|galaxy|android|phone|ipod)\b/i.test(label)
      ? "smartphone"
      : "monitor",
    true,
  );
}

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

/**
 * The signed-in person row: the initial in a round avatar, the name over the email, and (with
 * `notYouForm`) a quiet **Not you?** submit that belongs to that form. `name` and `email` plain text.
 */
export function personRow(opts: {
  name: string;
  email?: string | null;
  notYouForm?: { form: string; field: string; value: string };
}): string {
  const initial = [...opts.name][0]?.toUpperCase() ?? "?";
  const email =
    opts.email && opts.email !== opts.name
      ? `<span>${escapeHtml(opts.email).replace(/[@.]/g, "<wbr>$&")}</span>`
      : "";
  return (
    `<div class="person"><span class="ac-mono" aria-hidden="true">${escapeHtml(initial)}</span>` +
    `<div class="person-text"><span class="person-name">${escapeHtml(opts.name)}</span>${email}</div>` +
    (opts.notYouForm
      ? `<button class="quiet" type="submit" form="${escapeHtml(opts.notYouForm.form)}" name="${escapeHtml(opts.notYouForm.field)}" value="${escapeHtml(opts.notYouForm.value)}">Not you?</button>`
      : "") +
    `</div>`
  );
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
  /** The muted line below (the developer); plain text. */
  sub?: string;
  /** The device the app named: its own line, with a device glyph. */
  device?: string | null;
}): string {
  return `<div class="ac-head">${appArt(opts.name, opts.iconUrl)}<div class="ac-head-text">${appLines(opts)}</div></div>`;
}

function appArt(name: string, iconUrl?: string | null): string {
  return iconUrl
    ? `<img src="${escapeHtml(iconUrl)}" alt="" width="48" height="48">`
    : `<span class="ac-mono" aria-hidden="true">${escapeHtml([...name][0]?.toUpperCase() ?? "")}</span>`;
}

/** The lines beside an app's icon: name and action, developer, device (names are `<bdi>`). */
function appLines(opts: {
  name: string;
  action?: string;
  sub?: string;
  device?: string | null;
}): string {
  return (
    `<p class="ac-head-title"><strong><bdi>${escapeHtml(opts.name)}</bdi></strong>${opts.action ? ` ${escapeHtml(opts.action)}` : ""}</p>` +
    (opts.sub ? `<p class="ac-head-sub">${escapeHtml(opts.sub)}</p>` : "") +
    (opts.device
      ? `<p class="ac-head-sub ac-dev">${deviceIcon(opts.device)}<span>on <bdi>${escapeHtml(opts.device)}</bdi></span></p>`
      : "")
  );
}

/** The passport pane: art, the app's icon, developer and device, each on its own line. */
function passportPane(f: AppFacts): string {
  const art = f.artUrl
    ? `<img class="ac-art" src="${escapeHtml(f.artUrl)}" alt="" loading="lazy">`
    : "";
  const where = f.device
    ? `<p class="ac-head-sub ac-dev ac-pass-where">${deviceIcon(f.device)}<span>on <bdi>${escapeHtml(f.device)}</bdi></span></p>`
    : "";
  return `<aside class="ac-passport${f.artUrl ? "" : " ac-noart"}">${art}${appArt(f.name, f.iconUrl)}<div class="ac-pass-text">${appLines({ name: f.name, ...(f.action ? { action: f.action } : {}), ...(f.developer ? { sub: f.developer } : {}) })}</div>${where}</aside>`;
}

let keyLockup: string | null = null;
let lockerLockup: string | null = null;
let consoleLockup: string | null = null;

/** Heights (CSS px) of the trimmed lockups on Worker pages (docs/design/BRAND.md §1.4). */
export const BRAND_LOCKUP_HEIGHT = {
  /** Key: the kit's compact lockup as supplied (222 x 64), 52 px tall, 180 px wide: plrs.im's size. */
  key: 52,
  /** Locker: 437 x 80 canvas, so about 262 px wide (guide p.7 minimum 180). */
  locker: 48,
} as const;

/**
 * The brand block above the card. `surface` is the already-escaped surface label, or "". Both
 * brands draw an OUTLINED lockup (Key: the kit's compact one as supplied; Locker: the trimmed horizontal) (the name is never live text, BRAND.md Don'ts); the
 * surface label sits beside it as a small uppercase label, not as part of the name.
 */
function brandBlock(
  brand: BrandPageBrand | undefined,
  surface: string,
): string {
  const label = surface ? `<span class="surface">${surface}</span>` : "";
  const aria = surface ? ` ${surface}` : "";
  if (brand === "locker") {
    lockerLockup ??= themedLockup(
      "locker",
      "horizontal",
      BRAND_LOCKUP_HEIGHT.locker,
      "mark",
      true,
    );
    // The Locker lockup is its own wordmark: no surface label beside it.
    return `<div class="brand" role="img" aria-label="Polaris Locker${aria}">${lockerLockup}</div>`;
  }
  keyLockup ??= themedLockup("key", "compact", BRAND_LOCKUP_HEIGHT.key, "mark");
  return `<div class="brand" role="img" aria-label="Polaris Key${aria}">${keyLockup}${label}</div>`;
}

/**
 * A branded page: the console's brand block (the compact Polaris Key lockup, BRAND
 * §1.4, with the surface label beside it) above one card, so a Worker-served
 * sign-in error reads as the same design as the console's boot screen and the portal's login.
 * Built on first use, so a brand geometry this shell cannot theme fails that request rather
 * than the Worker's module load.
 */
export function renderBrandPage(opts: BrandPageOptions): string {
  if (opts.brand !== "key") return renderAuthCard(opts as AuthCardOptions);
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

/** Help and Privacy under every Polaris Locker card (no Terms: no such page exists). */
export const LOCKER_CARD_LINKS = [
  { label: "Help", href: "/docs/help/" },
  { label: "Privacy", href: "/docs/help/your-data/" },
] as const;

/**
 * The AuthCard's Worker twin: a Polaris Locker page (no script, no `style=` attribute) with the
 * same slots as `packages/admin/src/ui/auth/AuthCard.tsx`: the lockup, then one card with an
 * optional header (`header`, or the app's strip from `app`), the step (`heading` and `body`) and
 * an optional footer. Every Worker page a customer reaches is one. `body` and `header` are
 * TRUSTED markup built with the helpers above, every value escaped.
 */
export function renderAuthCard(opts: AuthCardOptions): string {
  const consoleCard = opts.brand === "console";
  const cardLinks = opts.links ?? (consoleCard ? [] : LOCKER_CARD_LINKS);
  lockerLockup ??= themedLockup(
    "locker",
    "horizontal",
    BRAND_LOCKUP_HEIGHT.locker,
    "mark",
    true,
  );
  consoleLockup ??= themedLockup(
    "key",
    "compact",
    BRAND_LOCKUP_HEIGHT.key,
    "mark",
  );
  const header =
    opts.header ??
    (opts.app
      ? appHeader({ name: opts.app.name, iconUrl: opts.app.iconUrl })
      : opts.passport
        ? appHeader({
            name: opts.passport.name,
            iconUrl: opts.passport.iconUrl,
            ...(opts.passport.action ? { action: opts.passport.action } : {}),
            ...(opts.passport.developer
              ? { sub: opts.passport.developer }
              : {}),
            device: opts.passport.device ?? null,
          })
        : "");
  // One trimmed Locker lockup (48 px tall, 262 wide) on every page (no size jump between steps): muted in an app's
  // context, full on `/tv` and on pages with no app (SIGN-IN.md §3.1).
  const inApp =
    (header !== "" || opts.passport !== undefined) && opts.variant !== "tv";
  const wide = opts.passport !== undefined && opts.variant !== "tv";
  const dark = THEME_TOKENS.dark.surface.page;
  const light = THEME_TOKENS.light.surface.page;
  return [
    `<!doctype html>`,
    `<html lang="en" data-brand="${consoleCard ? "console" : "locker"}">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(opts.title)} · ${consoleCard ? "Polaris Key Console" : "Polaris Locker"}</title>`,
    `<meta name="color-scheme" content="dark light">`,
    `<meta name="theme-color" content="${dark}" media="(prefers-color-scheme: dark)">`,
    `<meta name="theme-color" content="${light}" media="(prefers-color-scheme: light)">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<link rel="icon" type="image/svg+xml" href="${consoleCard ? BRAND_WEB_KEY_PATH : BRAND_WEB_LOCKER_PATH}/favicon.svg">`,
    `<style>${consoleCard ? BRAND_PAGE_CSS_CONSOLE : BRAND_PAGE_CSS_LOCKER}</style>`,
    `</head>`,
    opts.variant === "tv" ? `<body class="tv">` : `<body>`,
    consoleCard
      ? `<header class="ac-brand"><div role="img" aria-label="Polaris Key Console">${consoleLockup}<span class="ac-surface" aria-hidden="true">Console</span></div></header>`
      : `<header class="${inApp ? "ac-brand quiet" : "ac-brand"}"><div role="img" aria-label="Polaris Locker">${lockerLockup}</div></header>`,
    wide ? `<main class="ac ac-wide">` : `<main class="ac">`,
    header,
    wide ? passportPane(opts.passport!) : "",
    `<div class="ac-body">`,
    opts.preface ?? "",
    opts.focusHeading
      ? `<h1 tabindex="-1" autofocus>${escapeHtml(opts.heading)}</h1>`
      : `<h1>${escapeHtml(opts.heading)}</h1>`,
    opts.body ?? "",
    `</div>`,
    opts.footer
      ? `<footer class="ac-foot">${icon(opts.footer.icon, true)}<span>${escapeHtml(opts.footer.text)}</span></footer>`
      : "",
    `</main>`,
    cardLinks.length
      ? `<nav class="ac-links" aria-label="${escapeHtml(opts.linksLabel ?? "Help and privacy")}">${cardLinks
          .map(
            (l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`,
          )
          .join("")}</nav>`
      : "",
    `</body>`,
    `</html>`,
    ``,
  ]
    .filter((line, i, all) => line !== "" || i === all.length - 1)
    .join("\n");
}
