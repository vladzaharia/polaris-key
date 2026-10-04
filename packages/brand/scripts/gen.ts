// The brand generator.
//
//   pnpm --filter @polaris-key/brand gen              # (re)write every output
//   pnpm --filter @polaris-key/brand gen -- --check   # regenerate in memory; exit 1 on drift
//   pnpm gen:brand -- --check                         # the same, from the repo root
//
// Inputs: src/tokens/{primitives,source,scales}.ts (the design) and kit/ (the launch kit copy:
// geometry, lockups, badges, sprite). Outputs, each with a GENERATED banner:
//
//   css/tokens.css                      CSS custom properties: kit primitives, scales, the dark
//                                       and light themes (data-theme + prefers-color-scheme),
//                                       the per-section accent and section-bit variables
//   css/theme.css                       a Tailwind v4 `@theme inline` mapping onto tokens.css
//   tokens.json                         every token, resolved, for other generators
//   src/generated/tokens.ts             the same as typed TS constants
//   src/generated/geometry.ts           kit geometry, variant palettes and the sprite
//   src/generated/layouts.ts            the lockup and badge colour templates
//   lockups/delivery/*.svg              the "Polaris Key Delivery" lockups, every layout and kit
//                                       colour variant (scripts/delivery.ts sets the wordmark
//                                       from kit/source/fonts/Rubik-Bold.ttf)
//   sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd    GDScript constants
//   sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift         Swift constants
//   sdks/godot/addons/polaris_key/brand/*                                the Godot addon's
//                                       copies of kit files (the 16 px editor glyphs, the
//                                       "Powered by" credit screens and compact badges), each
//                                       SVG verbatim after a banner comment, in a `.gdignore`d
//                                       folder: an imported SVG's `.import` file differs between
//                                       engine versions, so the addon never imports them
//
// `--check` is the drift gate (CI, AGENTS.md's green gate). Like gen:constants, the TypeScript,
// JSON and CSS outputs are prettier-formatted here so `pnpm lint` and `pnpm format` agree.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

import { parseHex } from "../src/color.js";
import {
  BRAND,
  CLEAR_SPACE_RATIO,
  CUT_GRID,
  KIT_VERSION,
  OPTICAL,
  POWERED_BY,
} from "../src/tokens/primitives.js";
import { resolveTokens, type ResolvedTheme } from "../src/tokens/resolve.js";
import {
  ELEVATION,
  FONT,
  FONT_WEIGHT,
  LETTER_SPACING,
  MOTION,
  RADIUS,
  SPACE,
  TYPE_SCALE,
} from "../src/tokens/scales.js";
import {
  SERVICE_FAMILY,
  SERVICE_IDS,
  SERVICE_LABEL,
  SERVICE_MARK,
  STATUS_IDS,
  THEMES,
  type ServiceId,
  type Theme,
} from "../src/tokens/source.js";
import { DELIVERY_TITLE, deliveryLockups } from "./delivery.js";
import {
  KIT_PALETTES,
  LOCKUP_LAYOUTS,
  loadKit,
  renderTemplate,
  type KitVariant,
} from "./kit.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PKG, "..", "..");

const BANNER_LINES = [
  "GENERATED FILE — do not edit by hand.",
  "",
  "Written by `pnpm --filter @polaris-key/brand gen` (packages/brand/scripts/gen.ts) from",
  "packages/brand/src/tokens/ and the launch kit copy in packages/brand/kit/.",
  "`pnpm gen:brand -- --check` fails the green gate on any difference. To change a value, edit",
  "its source and regenerate.",
];

const banner = (prefix: string) =>
  BANNER_LINES.map((l) => (l ? `${prefix} ${l}` : prefix)).join("\n");

const cssBanner = `/*\n${BANNER_LINES.map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */`;

const T = resolveTokens();

// ── Per-section values ──────────────────────────────────────────────────────────────────────

export function serviceAccent(theme: Theme, id: ServiceId) {
  return T[theme].accent[SERVICE_FAMILY[id]];
}

/**
 * The section bit: the section's accent `solid`, or null on core. The platform (core) pages draw
 * no bit at all (owner decision 2026-10-03, docs/design/BRAND.md §6).
 */
export function sectionBit(theme: Theme, id: ServiceId): string | null {
  return id === "core" ? null : serviceAccent(theme, id).solid;
}

/** The section ids that carry a bit: every service, never core. */
const BIT_IDS = SERVICE_IDS.filter((id) => id !== "core");

/** The service section's bit, for outputs that only list BIT_IDS. */
const bitOf = (theme: Theme, id: ServiceId): string => sectionBit(theme, id)!;

// ── CSS ─────────────────────────────────────────────────────────────────────────────────────

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function themeVars(theme: Theme): [string, string][] {
  const t: ResolvedTheme = T[theme];
  const v: [string, string][] = [];
  for (const [k, x] of Object.entries(t.surface)) v.push([`surface-${k}`, x]);
  for (const [k, x] of Object.entries(t.text)) v.push([`text-${kebab(k)}`, x]);
  for (const [k, x] of Object.entries(t.border)) v.push([`border-${k}`, x]);
  v.push(["focus", t.focus]);
  v.push(["brand-violet", BRAND.violet[theme]]);
  v.push(["brand-gold", BRAND.gold[theme]]);
  v.push(["brand-star", BRAND.star[theme]]);
  v.push(["brand-page", BRAND.page[theme]]);
  v.push(["brand-text", BRAND.text[theme]]);
  v.push(["brand-muted", BRAND.muted[theme]]);
  v.push(["brand-rose", BRAND.rose[theme]]);
  for (const id of SERVICE_IDS) {
    const a = serviceAccent(theme, id);
    v.push([`service-${id}`, a.solid]);
    v.push([`service-${id}-fg`, a.fg]);
    v.push([`service-${id}-on`, a.on]);
    v.push([`service-${id}-subtle`, a.subtle]);
    const bit = sectionBit(theme, id);
    if (bit !== null) v.push([`service-${id}-bit`, bit]);
  }
  for (const s of STATUS_IDS) {
    const st = t.status[s];
    v.push([s, st.fg]);
    v.push([`${s}-on`, st.on]);
    v.push([`${s}-border`, st.border]);
    v.push([`${s}-subtle`, st.subtle]);
  }
  v.push(["signed", t.signed.solid]);
  v.push(["signed-on", t.signed.on]);
  v.push(["signed-border", t.signed.border]);
  v.push(["signed-subtle", t.signed.subtle]);
  v.push(["signed-mark", t.signed.mark]);
  for (const [k, x] of Object.entries(ELEVATION[theme]))
    v.push([`elevation-${k}`, x]);
  return v;
}

const decl = (vars: [string, string][]) =>
  vars.map(([k, v]) => `  --pk-${k}: ${v};`).join("\n");

// Core has no section bit: --pk-section-bit is `none` and the live bit is not displayed.
const sectionDecl = (id: ServiceId) =>
  [
    `  --pk-accent: var(--pk-service-${id});`,
    `  --pk-accent-fg: var(--pk-service-${id}-fg);`,
    `  --pk-accent-on: var(--pk-service-${id}-on);`,
    `  --pk-accent-subtle: var(--pk-service-${id}-subtle);`,
    id === "core"
      ? `  --pk-section-bit: none;`
      : `  --pk-section-bit: var(--pk-service-${id}-bit);`,
    `  --pk-section-bit-display: ${id === "core" ? "none" : "inline"};`,
  ].join("\n");

function scaleVars(): [string, string][] {
  const v: [string, string][] = [];
  for (const [k, x] of Object.entries(SPACE))
    v.push([`space-${k.replace(".", "_")}`, x]);
  for (const [k, x] of Object.entries(RADIUS)) v.push([`radius-${k}`, x]);
  v.push(["font-sans", FONT.sans]);
  v.push(["font-mono", FONT.mono]);
  for (const [k, x] of Object.entries(FONT_WEIGHT))
    v.push([`font-weight-${k}`, String(x)]);
  for (const [k, [size, lh]] of Object.entries(TYPE_SCALE)) {
    v.push([`font-size-${k}`, size]);
    v.push([`line-height-${k}`, lh]);
  }
  for (const [k, x] of Object.entries(LETTER_SPACING))
    v.push([`tracking-${k}`, x]);
  for (const [k, x] of Object.entries(MOTION.duration))
    v.push([`duration-${k}`, x]);
  for (const [k, x] of Object.entries(MOTION.easing)) v.push([`ease-${k}`, x]);
  return v;
}

function tokensCss(): string {
  const kitPrimitives = [
    ["polaris-key-violet-dark", BRAND.violet.dark],
    ["polaris-key-violet-light", BRAND.violet.light],
    ["polaris-key-gold-dark", BRAND.gold.dark],
    ["polaris-key-gold-light", BRAND.gold.light],
    ["polaris-key-page-dark", BRAND.page.dark],
    ["polaris-key-page-light", BRAND.page.light],
    ["polaris-key-star", "#fff"],
    ["polaris-key-star-soft", BRAND.muted.dark],
    ["polaris-key-rose-dark", BRAND.rose.dark],
    ["polaris-key-rose-light", BRAND.rose.light],
  ];
  const durations = Object.keys(MOTION.duration)
    .map((k) => `    --pk-duration-${k}: 0ms;`)
    .join("\n");
  return `${cssBanner}

/*
 * Polaris Key design tokens.
 *
 * THEME. Dark first: with no attribute the dark theme applies, and the light theme applies when
 * the OS asks for light (prefers-color-scheme). A persisted choice is written as
 * data-theme="dark" | "light" on <html> and overrides the system either way. data-theme on any
 * other element re-themes that subtree.
 *
 * SECTION. data-service="core|license|config|release|distribution|update|identity" on (or
 * inside) the themed element re-points --pk-accent*, and --pk-section-bit, at that section.
 * With no data-service the platform (core) values apply. Core has no section bit: the Pinned K
 * carries no terminal bit on platform pages (--pk-section-bit: none, and the live bit is
 * display: none); only service sections draw it, in their accent.
 */

:root {
  /* The kit's own primitives, verbatim (kit/08-developer/tokens.css). */
${kitPrimitives.map(([k, v]) => `  --${k}: ${v};`).join("\n")}

  /* Scales. */
${decl(scaleVars())}
}

:root,
[data-theme="dark"] {
  color-scheme: dark;
${decl(themeVars("dark"))}
}

@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) {
    color-scheme: light;
${decl(themeVars("light")).replace(/^/gm, "  ")}
  }
}

[data-theme="light"] {
  color-scheme: light;
${decl(themeVars("light"))}
}

/* The current section. Core (the platform) is the default. */
:root,
[data-theme],
[data-service="core"] {
${sectionDecl("core")}
}
${SERVICE_IDS.filter((id) => id !== "core")
  .map((id) => `\n[data-service="${id}"] {\n${sectionDecl(id)}\n}`)
  .join("\n")}

/* Reduced motion: every duration token collapses, so token-driven motion stops everywhere. */
@media (prefers-reduced-motion: reduce) {
  :root {
${durations}
  }
}

/* Rubik ships two weights; never let the browser fake a third. */
:root {
  font-synthesis: none;
}

/* The kit's mark class (kit/08-developer/tokens.css). */
.polaris-mark {
  display: inline-block;
  flex: none;
  vertical-align: middle;
}

/* The section bit eases between section colours; the star never animates. */
.polaris-section-bit {
  transition: fill var(--pk-duration-base) var(--pk-ease-standard);
}

/* The live section bit (bit="section"): the nearest data-service picks its colour, and core
   (or no data-service) does not display it at all. A class rule, never an inline style. */
.polaris-live-bit {
  fill: var(--pk-section-bit);
  display: var(--pk-section-bit-display);
}

@media (prefers-reduced-motion: reduce) {
  .polaris-section-bit {
    transition: none;
  }
}
`;
}

function themeCss(): string {
  const colors: [string, string][] = [];
  for (const k of ["page", "raised", "overlay", "sunken"])
    colors.push([`surface-${k}`, `surface-${k}`]);
  colors.push(["fg-strong", "text-strong"]);
  colors.push(["fg", "text-default"]);
  colors.push(["fg-muted", "text-muted"]);
  colors.push(["fg-subtle", "text-subtle"]);
  colors.push(["fg-on-accent", "text-on-accent"]);
  colors.push(["border", "border-subtle"]);
  colors.push(["border-strong", "border-strong"]);
  colors.push(["focus", "focus"]);
  for (const k of ["", "-fg", "-on", "-subtle"])
    colors.push([`accent${k}`, `accent${k}`]);
  colors.push(["section-bit", "section-bit"]);
  for (const id of SERVICE_IDS)
    for (const k of ["", "-fg", "-on", "-subtle"])
      colors.push([`service-${id}${k}`, `service-${id}${k}`]);
  for (const s of STATUS_IDS)
    for (const k of ["", "-on", "-border", "-subtle"])
      colors.push([`${s}${k}`, `${s}${k}`]);
  for (const k of ["", "-on", "-border", "-subtle", "-mark"])
    colors.push([`signed${k}`, `signed${k}`]);
  for (const k of ["violet", "gold", "star", "page", "text", "muted", "rose"])
    colors.push([`brand-${k}`, `brand-${k}`]);
  const lines: string[] = [];
  for (const [tw, pk] of colors)
    lines.push(`  --color-${tw}: var(--pk-${pk});`);
  lines.push("");
  lines.push(`  --font-sans: var(--pk-font-sans);`);
  lines.push(`  --font-mono: var(--pk-font-mono);`);
  lines.push(`  --font-weight-normal: var(--pk-font-weight-regular);`);
  lines.push(`  --font-weight-bold: var(--pk-font-weight-bold);`);
  for (const k of Object.keys(TYPE_SCALE)) {
    lines.push(`  --text-${k}: var(--pk-font-size-${k});`);
    lines.push(`  --text-${k}--line-height: var(--pk-line-height-${k});`);
  }
  lines.push("");
  lines.push(`  --spacing: 0.25rem;`);
  for (const k of Object.keys(RADIUS))
    lines.push(`  --radius-${k}: var(--pk-radius-${k});`);
  for (const k of ["1", "2", "3"])
    lines.push(`  --shadow-elevation-${k}: var(--pk-elevation-${k});`);
  for (const k of Object.keys(MOTION.easing))
    lines.push(`  --ease-${k}: var(--pk-ease-${k});`);
  return `${cssBanner}

/*
 * Tailwind v4 theme for Polaris Key. Import after Tailwind and after tokens.css:
 *
 *   @import "tailwindcss";
 *   @import "@polaris-key/brand/tokens.css";
 *   @import "@polaris-key/brand/theme.css";
 *
 * \`@theme inline\` makes every utility read the live --pk-* variable, so data-theme and
 * data-service switch the utilities too (bg-surface-raised, text-fg-muted, border-border,
 * bg-accent, text-service-config-fg, bg-signed, ring-focus, rounded-lg, shadow-elevation-2…).
 * Tailwind's default palette is left alone; reach for these names instead.
 */

@theme inline {
${lines.join("\n")}
}

/*
 * dark: and light: follow the same mechanics as tokens.css: data-theme wins, otherwise the OS
 * preference, otherwise dark.
 */
@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) {
    @slot;
  }
  @media not (prefers-color-scheme: light) {
    &:where(:not([data-theme="light"], [data-theme="light"] *)) {
      @slot;
    }
  }
}

@custom-variant light {
  &:where([data-theme="light"], [data-theme="light"] *) {
    @slot;
  }
  @media (prefers-color-scheme: light) {
    &:where(:not([data-theme="dark"], [data-theme="dark"] *)) {
      @slot;
    }
  }
}
`;
}

// ── JSON and TypeScript ─────────────────────────────────────────────────────────────────────

function tokenModel() {
  const services = Object.fromEntries(
    THEMES.map((t) => [
      t,
      Object.fromEntries(
        SERVICE_IDS.map((id) => [
          id,
          { ...serviceAccent(t, id), bit: sectionBit(t, id) },
        ]),
      ),
    ]),
  );
  return {
    kitVersion: KIT_VERSION,
    brand: BRAND,
    optical: OPTICAL,
    cutGrid: CUT_GRID,
    clearSpaceRatio: CLEAR_SPACE_RATIO,
    poweredBy: POWERED_BY,
    themes: T,
    services,
    serviceFamily: SERVICE_FAMILY,
    serviceMark: SERVICE_MARK,
    serviceLabel: SERVICE_LABEL,
    space: SPACE,
    radius: RADIUS,
    elevation: ELEVATION,
    motion: MOTION,
    font: FONT,
    fontWeight: FONT_WEIGHT,
    typeScale: TYPE_SCALE,
    letterSpacing: LETTER_SPACING,
  };
}

function tokensJson(): string {
  return JSON.stringify(
    { $comment: BANNER_LINES.filter(Boolean).join(" "), ...tokenModel() },
    null,
    2,
  );
}

function tokensTs(): string {
  const m = tokenModel();
  return `${banner("//")}

import type { ResolvedTheme } from "../tokens/resolve.js";
import type { ServiceId, Theme } from "../tokens/source.js";

/** Every semantic colour, resolved to hex, per theme. */
export const THEME_TOKENS = ${JSON.stringify(m.themes)} as const satisfies Record<Theme, ResolvedTheme>;

/**
 * Per theme, each section's accent (solid, fg, on, subtle) and its section-bit colour; bit is
 * null on core, which draws no bit.
 */
export const SERVICE_ACCENTS = ${JSON.stringify(m.services)} as const satisfies Record<
  Theme,
  Record<
    ServiceId,
    { solid: string; fg: string; on: string; subtle: string; bit: string | null }
  >
>;
`;
}

const KIT = loadKit(join(PKG, "kit"));

/** The "Polaris Key Delivery" lockups, set from the bundled Rubik Bold (scripts/delivery.ts). */
const DELIVERY = deliveryLockups(join(PKG, "kit"), KIT.lockups);

function geometryTs(): string {
  return `${banner("//")}

import type { KitPalette } from "../marks/types.js";

/** kit/source/geometry.json: per mark and optical cut, [grid, [role, path][]]. */
export const GEOMETRY = ${JSON.stringify(KIT.geometry)} as const;

/** The colour each role takes in each kit variant. */
export const KIT_PALETTES = ${JSON.stringify(KIT_PALETTES)} as const satisfies Record<string, KitPalette>;

/** kit/08-developer/polaris-sprite.svg, verbatim: currentColor symbols for both marks. */
export const SPRITE = ${JSON.stringify(KIT.sprite)};
`;
}

function layoutsTs(): string {
  return `${banner("//")}
//
// Templates: each layout's inner SVG markup with \`{role}\` placeholders for its colours. The
// generator proves that every kit variant's palette reproduces the kit file byte for byte.

import type { KitTemplate } from "../marks/types.js";

/**
 * Per lockup and layout: kit/02-lockups (key, update), and the "${DELIVERY_TITLE}" lockups
 * (delivery: the kit's Star Cut glyph with a Rubik Bold wordmark set by scripts/delivery.ts).
 */
export const LOCKUP_TEMPLATES: Record<
  "key" | "update" | "delivery",
  Record<"horizontal" | "stacked" | "compact", KitTemplate>
> = ${JSON.stringify({ ...KIT.lockups, delivery: DELIVERY })};

/** The glyph inside each lockup at its natural size: optical cut and edge length (CSS px). */
export const LOCKUP_GLYPHS = ${JSON.stringify({ ...KIT.lockupGlyphs, delivery: KIT.lockupGlyphs.update })} as const;

/** kit/03-powered-by: per style and layout. */
export const BADGE_TEMPLATES: Record<
  "transparent" | "sticker" | "outline",
  Record<"horizontal" | "compact" | "stacked", KitTemplate>
> = ${JSON.stringify(KIT.badges)};
`;
}

// ── GDScript ────────────────────────────────────────────────────────────────────────────────

const upper = (s: string) =>
  s
    .replace(/[A-Z]/g, (c) => `_${c}`)
    .replace(/-/g, "_")
    .toUpperCase();

function gdColor(hex: string): string {
  const { r, g, b } = parseHex(hex);
  const f = (x: number) => {
    const s = Number(x.toFixed(6)).toString();
    return s.includes(".") ? s : `${s}.0`;
  };
  return `Color(${f(r)}, ${f(g)}, ${f(b)}, 1.0)`;
}

function gdTheme(theme: Theme): string {
  const t = T[theme];
  const out: string[] = [];
  const c = (name: string, hex: string) =>
    out.push(`\tconst ${name} := ${gdColor(hex)} # ${hex}`);
  for (const [k, x] of Object.entries(t.surface)) c(`SURFACE_${upper(k)}`, x);
  for (const [k, x] of Object.entries(t.text)) c(`TEXT_${upper(k)}`, x);
  for (const [k, x] of Object.entries(t.border)) c(`BORDER_${upper(k)}`, x);
  c("FOCUS", t.focus);
  for (const s of STATUS_IDS) {
    const st = t.status[s];
    c(upper(s), st.fg);
    c(`${upper(s)}_ON`, st.on);
    c(`${upper(s)}_BORDER`, st.border);
    c(`${upper(s)}_SUBTLE`, st.subtle);
  }
  c("SIGNED", t.signed.solid);
  c("SIGNED_ON", t.signed.on);
  c("SIGNED_BORDER", t.signed.border);
  c("SIGNED_SUBTLE", t.signed.subtle);
  c("SIGNED_MARK", t.signed.mark);
  c("BRAND_VIOLET", BRAND.violet[theme]);
  c("BRAND_STAR", BRAND.star[theme]);
  c("BRAND_GOLD", BRAND.gold[theme]);
  for (const id of SERVICE_IDS) {
    const a = serviceAccent(theme, id);
    c(`SERVICE_${upper(id)}`, a.solid);
    c(`SERVICE_${upper(id)}_FG`, a.fg);
    c(`SERVICE_${upper(id)}_ON`, a.on);
    c(`SERVICE_${upper(id)}_SUBTLE`, a.subtle);
    const bit = sectionBit(theme, id);
    if (bit !== null) c(`SERVICE_${upper(id)}_BIT`, bit);
  }
  return out.join("\n");
}

function gdScript(): string {
  const svc = (theme: Theme, part: "solid" | "fg" | "on" | "subtle" | "bit") =>
    (part === "bit" ? BIT_IDS : SERVICE_IDS)
      .map((id) => {
        const v =
          part === "bit" ? bitOf(theme, id) : serviceAccent(theme, id)[part];
        return `\t"${id}": ${gdColor(v)},`;
      })
      .join("\n");
  return `${banner("#")}
class_name PKeyBrand
extends RefCounted
## Polaris Key brand tokens for Godot UI: the kit primitives, the dark and light semantic
## palettes, the per-section accents and the optical-size thresholds. Read them as
## \`PKeyBrand.Dark.SURFACE_PAGE\`, \`PKeyBrand.service_accent("config", true)\`.
##
## Dark is the default theme (the kit's page ground #060912). Choose the optical cut by the
## DISPLAYED size: below 24 px the 16 px favicon cut, 24-32 px the service cut, above that the
## display master. The default mark has no terminal bit; a service section's bit (its accent)
## shows only at a glyph of 48 px or more, and core draws none.


## Kit primitives, verbatim (kit/08-developer/tokens.json).
const KIT_VIOLET_DARK := ${gdColor(BRAND.violet.dark)}
const KIT_VIOLET_LIGHT := ${gdColor(BRAND.violet.light)}
const KIT_GOLD_DARK := ${gdColor(BRAND.gold.dark)}
const KIT_GOLD_LIGHT := ${gdColor(BRAND.gold.light)}
const KIT_PAGE_DARK := ${gdColor(BRAND.page.dark)}
const KIT_PAGE_LIGHT := ${gdColor(BRAND.page.light)}
const KIT_STAR_DARK := ${gdColor(BRAND.star.dark)}
const KIT_STAR_LIGHT := ${gdColor(BRAND.star.light)}
const KIT_MUTED_DARK := ${gdColor(BRAND.muted.dark)}
const KIT_MUTED_LIGHT := ${gdColor(BRAND.muted.light)}

## Optical sizes and minimums (CSS/logical pixels, never physical).
const FAVICON_BELOW := ${OPTICAL.faviconBelow}
const SERVICE_MAX := ${OPTICAL.serviceMax}
const GOLD_MINIMUM_GLYPH := ${OPTICAL.goldMinimumGlyphSize}
const CLEAR_SPACE_RATIO := ${CLEAR_SPACE_RATIO}
const POWERED_BY_PHRASE := "${POWERED_BY.phrase}"
const BADGE_MIN_HORIZONTAL := Vector2i(${POWERED_BY.minimum.horizontal.width}, ${POWERED_BY.minimum.horizontal.height})
const BADGE_MIN_COMPACT := Vector2i(${POWERED_BY.minimum.compact.width}, ${POWERED_BY.minimum.compact.height})
const BADGE_MIN_STACKED := Vector2i(${POWERED_BY.minimum.stacked.width}, ${POWERED_BY.minimum.stacked.height})

## Section ids: core plus every service slug.
const SERVICE_IDS: Array[String] = [${SERVICE_IDS.map((s) => `"${s}"`).join(", ")}]


## The dark theme (default).
class Dark:
${gdTheme("dark")}


## The light theme.
class Light:
${gdTheme("light")}


const _SERVICE_DARK := {
${svc("dark", "solid")}
}
const _SERVICE_LIGHT := {
${svc("light", "solid")}
}
const _SERVICE_FG_DARK := {
${svc("dark", "fg")}
}
const _SERVICE_FG_LIGHT := {
${svc("light", "fg")}
}
const _BIT_DARK := {
${svc("dark", "bit")}
}
const _BIT_LIGHT := {
${svc("light", "bit")}
}


## A section's accent (indicators, fills). Unknown ids answer the core violet.
static func service_accent(service: String, dark: bool = true) -> Color:
\tvar table: Dictionary = _SERVICE_DARK if dark else _SERVICE_LIGHT
\treturn table.get(service, table["core"])


## A section's text colour (>= 4.5:1 on every surface of the theme).
static func service_fg(service: String, dark: bool = true) -> Color:
\tvar table: Dictionary = _SERVICE_FG_DARK if dark else _SERVICE_FG_LIGHT
\treturn table.get(service, table["core"])


## Whether a section draws the K's terminal bit: every service section does; core (the platform)
## and unknown ids do not. The default Polaris Key mark has no bit.
static func has_section_bit(service: String) -> bool:
\treturn _BIT_DARK.has(service)


## The K's terminal-bit colour for a service section (its accent). Core and unknown ids have no
## bit and answer transparent; check has_section_bit() and leave the bit out instead.
static func section_bit(service: String, dark: bool = true) -> Color:
\tvar table: Dictionary = _BIT_DARK if dark else _BIT_LIGHT
\treturn table.get(service, Color(0, 0, 0, 0))


## Which optical cut a mark displayed at \`size\` logical pixels uses.
static func optical_cut(size: float) -> String:
\tif size < FAVICON_BELOW:
\t\treturn "favicon"
\tif size <= SERVICE_MAX:
\t\treturn "service"
\treturn "display"


## Whether the K's terminal bit may be drawn at this displayed glyph size.
static func bit_visible(size: float) -> bool:
\treturn size >= GOLD_MINIMUM_GLYPH
`;
}

// ── Swift ───────────────────────────────────────────────────────────────────────────────────

function swiftRgb(hex: string): string {
  return `BrandColor(hex: 0x${hex.slice(1)})`;
}

const bitSwift = (hex: string | null) => (hex === null ? "nil" : swiftRgb(hex));

function swiftTheme(theme: Theme): string {
  const t = T[theme];
  const out: string[] = [];
  const c = (name: string, hex: string) =>
    out.push(`        public static let ${name} = ${swiftRgb(hex)}`);
  for (const [k, x] of Object.entries(t.surface))
    c(`surface${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  for (const [k, x] of Object.entries(t.text))
    c(`text${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  for (const [k, x] of Object.entries(t.border))
    c(`border${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  c("focus", t.focus);
  for (const s of STATUS_IDS) {
    const st = t.status[s];
    c(s, st.fg);
    c(`${s}On`, st.on);
    c(`${s}Border`, st.border);
    c(`${s}Subtle`, st.subtle);
  }
  c("signed", t.signed.solid);
  c("signedOn", t.signed.on);
  c("signedBorder", t.signed.border);
  c("signedSubtle", t.signed.subtle);
  c("signedMark", t.signed.mark);
  c("brandViolet", BRAND.violet[theme]);
  c("brandStar", BRAND.star[theme]);
  c("brandGold", BRAND.gold[theme]);
  return out.join("\n");
}

function swiftSource(): string {
  const table = (theme: Theme) =>
    SERVICE_IDS.map((id) => {
      const a = serviceAccent(theme, id);
      return `            "${id}": BrandAccent(solid: ${swiftRgb(a.solid)}, fg: ${swiftRgb(a.fg)}, on: ${swiftRgb(a.on)}, subtle: ${swiftRgb(a.subtle)}, bit: ${bitSwift(sectionBit(theme, id))}),`;
    }).join("\n");
  return `${banner("//")}

#if canImport(SwiftUI)
    import SwiftUI
#endif

/// An sRGB brand colour. \`hex\` is the 0xRRGGBB value the design system specifies.
public struct BrandColor: Sendable, Equatable, Hashable {
    public let hex: UInt32

    public init(hex: UInt32) {
        self.hex = hex
    }

    public var red: Double { Double((hex >> 16) & 0xFF) / 255.0 }
    public var green: Double { Double((hex >> 8) & 0xFF) / 255.0 }
    public var blue: Double { Double(hex & 0xFF) / 255.0 }

    #if canImport(SwiftUI)
        public var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: 1) }
    #endif
}

/// One section's accent in one theme: \`solid\` for indicators and fills, \`fg\` for text, \`on\` for
/// text on a solid fill, \`subtle\` for a tinted surface, \`bit\` for the K's terminal bit (nil on
/// core: the platform draws no bit).
public struct BrandAccent: Sendable, Equatable {
    public let solid: BrandColor
    public let fg: BrandColor
    public let on: BrandColor
    public let subtle: BrandColor
    public let bit: BrandColor?
}

/// Polaris Key brand tokens (@polaris-key/brand). Dark is the default theme.
public enum PolarisBrand {
    /// Kit primitives, verbatim (kit/08-developer/tokens.json).
    public enum Kit {
        public static let violetDark = ${swiftRgb(BRAND.violet.dark)}
        public static let violetLight = ${swiftRgb(BRAND.violet.light)}
        public static let goldDark = ${swiftRgb(BRAND.gold.dark)}
        public static let goldLight = ${swiftRgb(BRAND.gold.light)}
        public static let pageDark = ${swiftRgb(BRAND.page.dark)}
        public static let pageLight = ${swiftRgb(BRAND.page.light)}
        public static let starDark = ${swiftRgb(BRAND.star.dark)}
        public static let starLight = ${swiftRgb(BRAND.star.light)}
        public static let mutedDark = ${swiftRgb(BRAND.muted.dark)}
        public static let mutedLight = ${swiftRgb(BRAND.muted.light)}
    }

    /// Optical cuts by displayed (point) size, never pixel density.
    public static let faviconBelow: Double = ${OPTICAL.faviconBelow}
    public static let serviceMax: Double = ${OPTICAL.serviceMax}
    public static let goldMinimumGlyph: Double = ${OPTICAL.goldMinimumGlyphSize}
    public static let clearSpaceRatio: Double = ${CLEAR_SPACE_RATIO}
    public static let poweredByPhrase = "${POWERED_BY.phrase}"

    /// Section ids: core plus every service slug.
    public static let serviceIds: [String] = [${SERVICE_IDS.map((s) => `"${s}"`).join(", ")}]

    /// The dark theme (default).
    public enum Dark {
${swiftTheme("dark")}
    }

    /// The light theme.
    public enum Light {
${swiftTheme("light")}
    }

    private static let accentsDark: [String: BrandAccent] = [
${table("dark")}
    ]

    private static let accentsLight: [String: BrandAccent] = [
${table("light")}
    ]

    /// A section's accent. Unknown ids answer the core (platform) violet.
    public static func accent(for service: String, dark: Bool = true) -> BrandAccent {
        let table = dark ? accentsDark : accentsLight
        return table[service] ?? table["core"]!
    }

    /// Which optical cut a mark displayed at \`size\` points uses.
    public static func opticalCut(for size: Double) -> String {
        if size < faviconBelow { return "favicon" }
        if size <= serviceMax { return "service" }
        return "display"
    }
}
`;
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────

interface Target {
  path: string;
  render: () => string;
  parser?: "typescript" | "json" | "css";
}

const DELIVERY_VARIANTS: KitVariant[] = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
  "currentColor",
];

/**
 * The Godot addon's brand folder (P1-12): kit files copied verbatim, so the addon's editor icon and
 * the credits it offers are the kit's own and cannot drift. The Pinned K glyphs are the bit-less
 * favicon cut (BRAND.md owner decisions, 2026-10-03).
 */
const GODOT_BRAND_DIR = "sdks/godot/addons/polaris_key/brand";
const GODOT_BRAND_ASSETS: [string, string][] = [
  ["polaris_key-dark.svg", "06-games/key/dark/key-16.svg"],
  ["polaris_key-light.svg", "06-games/key/light/key-16.svg"],
  ["powered-by-credit-dark.svg", "06-games/powered-by-credit-dark.svg"],
  ["powered-by-credit-light.svg", "06-games/powered-by-credit-light.svg"],
  [
    "powered-by-compact-dark.svg",
    "03-powered-by/transparent/powered-by-compact-dark.svg",
  ],
  [
    "powered-by-compact-light.svg",
    "03-powered-by/transparent/powered-by-compact-light.svg",
  ],
];

/** A kit SVG with the GENERATED banner as an XML comment in front of it (after any prolog). */
export function godotBrandSvg(kitPath: string): string {
  const svg = readFileSync(join(PKG, "kit", kitPath), "utf8");
  const lines = BANNER_LINES.map((l) =>
    l.startsWith("packages/brand/src/tokens/")
      ? `packages/brand/kit/${kitPath}, verbatim.`
      : l,
  );
  const comment = `<!--\n${lines.map((l) => (l ? `  ${l}` : "")).join("\n")}\n-->\n`;
  const prolog = /^<\?xml[^>]*\?>\n?/.exec(svg);
  return prolog
    ? prolog[0] + comment + svg.slice(prolog[0].length)
    : comment + svg;
}

const TARGETS: Target[] = [
  { path: "packages/brand/css/tokens.css", render: tokensCss, parser: "css" },
  { path: "packages/brand/css/theme.css", render: themeCss, parser: "css" },
  { path: "packages/brand/tokens.json", render: tokensJson, parser: "json" },
  {
    path: "packages/brand/src/generated/tokens.ts",
    render: tokensTs,
    parser: "typescript",
  },
  {
    path: "packages/brand/src/generated/geometry.ts",
    render: geometryTs,
    parser: "typescript",
  },
  {
    path: "packages/brand/src/generated/layouts.ts",
    render: layoutsTs,
    parser: "typescript",
  },
  ...LOCKUP_LAYOUTS.flatMap((layout) =>
    DELIVERY_VARIANTS.map((variant) => ({
      path: `packages/brand/lockups/delivery/delivery-${layout}-${variant}.svg`,
      render: () => renderTemplate(DELIVERY[layout], KIT_PALETTES[variant]),
    })),
  ),
  {
    path: "sdks/godot/addons/polaris_key/ui/theme/brand_tokens_generated.gd",
    render: gdScript,
  },
  {
    path: "sdks/swift/Sources/PolarisKeyUI/BrandTokens.generated.swift",
    render: swiftSource,
  },
  {
    path: `${GODOT_BRAND_DIR}/.gdignore`,
    render: () =>
      "# GENERATED by `pnpm gen:brand`: Godot never imports this folder (see packages/brand/scripts/gen.ts).",
  },
  ...GODOT_BRAND_ASSETS.map(([name, kitPath]) => ({
    path: `${GODOT_BRAND_DIR}/${name}`,
    render: () => godotBrandSvg(kitPath),
  })),
];

export async function renderAll(root = ROOT): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const options =
    (await prettier.resolveConfig(join(root, "package.json"))) ?? {};
  for (const target of TARGETS) {
    let content = target.render();
    if (target.parser)
      content = await prettier.format(content, {
        ...options,
        parser: target.parser,
      });
    else if (!content.endsWith("\n")) content += "\n";
    out.set(target.path, content);
  }
  return out;
}

export async function run(opts: {
  check: boolean;
  root?: string;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const stale: string[] = [];
  for (const [path, content] of await renderAll(root)) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return stale;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale: string[];
  try {
    stale = await run({ check });
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }
  if (check) {
    for (const path of stale)
      console.error(`stale: ${path} — run \`pnpm gen:brand\``);
    if (stale.length > 0) process.exit(1);
    console.log("up to date: every generated brand output");
    return;
  }
  for (const path of stale)
    console.log(`wrote ${relative(process.cwd(), join(ROOT, path))}`);
  if (stale.length === 0) console.log("nothing to write");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) await main();
