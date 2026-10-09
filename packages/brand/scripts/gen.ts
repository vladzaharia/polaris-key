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
//   sdks/kotlin/ui/src/main/kotlin/im/plrs/key/ui/brand/PolarisBrandTokens.generated.kt
//                                       Kotlin (Compose) constants for the Compose UI kit, with
//                                       the bit-less display-cut Pinned K and the compact
//                                       "Powered by" badge as vector data (P6-11)
//   sdks/kotlin/ui/src/main/res/font/*  the Compose kit's Rubik: each kit TTF byte for byte, with
//                                       the kit's OFL.txt and notice in the module's assets
//   sdks/godot/addons/polaris_key/brand/*                                the Godot addon's
//                                       copies of kit files (the 16 px editor glyphs, the
//                                       "Powered by" credit screens and compact badges), each
//                                       SVG verbatim after a banner comment, in a `.gdignore`d
//                                       folder: an imported SVG's `.import` file differs between
//                                       engine versions, so the addon never imports them
//   sdks/godot/addons/polaris_key/ui/theme/fonts/*                       the UI kit's Rubik:
//                                       each kit TTF (kit/source/fonts/) unchanged, base64 in a
//                                       text FontFile resource (no importer, so no per-engine
//                                       `.import` file), with the kit's OFL.txt and notice
//   sdks/godot/addons/polaris_key/ui/theme/brand_marks_generated.gd      the kit SVGs the UI kit
//                                       rasterises at run time when branding is on (the bit-less
//                                       display-cut Pinned K, the compact "Powered by" badge)
//   the kit copy tables (scripts/kit-copy.ts, plans/UK-02.md §3.3) from kit-copy/ and the core
//   copy in conformance/parity/copy.<locale>.json: src/generated/kit-copy/<locale>.json + index.ts,
//   packages/sdk-node/src/kitCopy.generated.ts, PolarisKeyUI/Resources/Localizable.xcstrings,
//   sdks/kotlin/ui/src/commonMain/composeResources/values*/strings.xml, the Godot kit's
//   ui/locale/*.po(t), and polaris_key/ui/kit_copy_generated.py + ui/locale/*.pot
//
// The UI-kit outputs (docs/design/UI-KITS.md §2; renderers in ./gen-kit.ts, design source in
// src/tokens/{kit,terminal,accent-vectors}.ts and src/accent.ts):
//
//   css/kit.css, src/generated/kit.ts   the kit component tokens, type scale, motion, danger solid
//   fixtures/accent-vectors.json        the accent resolver's shared vectors, and their copies in
//                                       every SDK's tests (Swift and Kotlin as literals)
//   sdks/swift/.../KitTokens.generated.swift, sdks/kotlin/ui/.../PolarisKitTokens.generated.kt
//   sdks/godot/.../ui/theme/{kit_tokens,kit_icons}_generated.gd, the variable fonts as MSDF
//                                       FontFiles, addons/polaris_key/dotnet/PKeyBrand.generated.cs
//   sdks/python/src/polaris_key/ui/     _tokens.py, ansi.py, qt/Theme.qml + qmldir + QSS, fonts/
//   packages/sdk-node/src/cli/tokens.generated.ts   the terminal tables
//   the variable Rubik and JetBrains Mono (fonts/ttf/) copied into the Kotlin and Python kits
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
  DISPLAY_MIN_PX,
  DISPLAY_SCALE,
  DISPLAY_TRACKING,
  LETTER_SPACING,
  MOTION,
  MOTION_EASING_FALLBACK,
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
  accentVectorsJson,
  csharpBrand,
  gdIcons,
  gdKit,
  godotVariableFontTres,
  kitCss,
  kitModel,
  kitTs,
  kotlinKit,
  kotlinVectors,
  nodeTerminal,
  pythonAnsi,
  pythonTokens,
  qtQml,
  qtQmldir,
  qtQss,
  swiftKit,
  swiftVectors,
  type KitGenContext,
} from "./gen-kit.js";
import {
  KIT_PALETTES,
  LOCKUP_LAYOUTS,
  loadKit,
  renderTemplate,
  type KitVariant,
} from "./kit.js";
import { KIT_COPY_TARGETS } from "./kit-copy.js";

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

/** The B17 state tokens of one theme, flat: [camelCase kind, service id, hex]. */
const STATE_KINDS = [
  "ring",
  "selectedFill",
  "hoverTint",
  "checkedFill",
  "checkedOn",
  "checkedEdge",
  "contextEdge",
] as const;

function stateEntries(theme: Theme): [string, ServiceId, string][] {
  return SERVICE_IDS.flatMap((id) =>
    STATE_KINDS.map((k): [string, ServiceId, string] => [
      k,
      id,
      T[theme].state[id][k],
    ]),
  );
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

function themeVars(theme: Theme): [string, string][] {
  const t: ResolvedTheme = T[theme];
  const v: [string, string][] = [];
  for (const [k, x] of Object.entries(t.surface)) v.push([`surface-${k}`, x]);
  for (const [k, x] of Object.entries(t.text)) v.push([`text-${kebab(k)}`, x]);
  for (const [k, x] of Object.entries(t.border)) v.push([`border-${k}`, x]);
  v.push(["focus", t.focus]);
  v.push(["action", t.action.fill]);
  v.push(["action-on", t.action.on]);
  for (const [k, id, hex] of stateEntries(theme))
    v.push([`state-${id}-${kebab(k)}`, hex]);
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
    ...STATE_KINDS.map(
      (k) => `  --pk-state-${kebab(k)}: var(--pk-state-${id}-${kebab(k)});`,
    ),
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
  for (const [k, x] of Object.entries(MOTION.distance))
    v.push([`motion-distance-${k}`, x]);
  for (const [k, x] of Object.entries(MOTION.scale))
    v.push([`motion-scale-${k}`, String(x)]);
  v.push(["stagger-step", MOTION.stagger.step]);
  v.push(["stagger-max", String(MOTION.stagger.max)]);
  for (const [k, x] of Object.entries(MOTION.delay)) v.push([`delay-${k}`, x]);
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
  // Reduced motion collapses every duration and the stagger step, never the delays (S-23 D3).
  const collapsed = [
    ...Object.keys(MOTION.duration).map((k) => `--pk-duration-${k}`),
    "--pk-stagger-step",
  ];
  const reduced = (indent: string) =>
    collapsed.map((name) => `${indent}${name}: 0ms;`).join("\n");
  const fallbacks = Object.entries(MOTION_EASING_FALLBACK)
    .map(([k, x]) => `    --pk-ease-${k}: ${x};`)
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

/* Commerce shares the Distribution family (B1): same declarations, its own selector. */
[data-service="commerce"] {
${sectionDecl("distribution")}
}

/* Where linear() is unsupported, the spring easing falls back to standard. */
@supports not (transition-timing-function: linear(0, 1)) {
  :root {
${fallbacks}
  }
}

/*
 * Reduced motion swaps instantly: every duration token and the stagger step collapse to 0 ms, so
 * token-driven motion stops everywhere. The delays (--pk-delay-*) are not motion and stay. The
 * OS setting and the in-app preference (data-motion="reduce" on <html>) do the same.
 */
@media (prefers-reduced-motion: reduce) {
  :root {
${reduced("    ")}
  }
}

:root[data-motion="reduce"] {
${reduced("  ")}
}

/* Every weight and style in use ships in the variable fonts; never let a browser fake one. */
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

:root[data-motion="reduce"] .polaris-section-bit {
  transition: none;
}
`;
}

function marketingCss(): string {
  const sizes = Object.entries(DISPLAY_SCALE)
    .map(
      ([k, [size, lh]]) =>
        `  --pk-display-size-${k}: ${size};\n  --pk-display-line-height-${k}: ${lh};`,
    )
    .join("\n");
  const classes = Object.keys(DISPLAY_SCALE)
    .map(
      (k) => `.pk-display-${k} {
  font-family: var(--pk-font-sans);
  font-weight: var(--pk-font-weight-semibold);
  font-size: var(--pk-display-size-${k});
  line-height: var(--pk-display-line-height-${k});
  letter-spacing: var(--pk-tracking-display);
}`,
    )
    .join("\n\n");
  return `${cssBanner}

/*
 * Polaris Key marketing expression: the display type scale, display and heading tracking and the
 * eyebrow, for marketing pages (plrs.im) and the docs landing ONLY. Never import this into the
 * console, the portal, the hosted sign-in, a table, a form or a kit (BRAND.md §14.3, B6, B11).
 * Import after tokens.css:
 *
 *   @import "@polaris-key/brand/tokens.css";
 *   @import "@polaris-key/brand/marketing.css";
 *
 * Product chrome that needs a large heading takes --pk-tracking-product-display: at most -0.02em
 * and only from ${DISPLAY_MIN_PX} px up; below ${DISPLAY_MIN_PX} px tracking stays at 0. The display scale starts at
 * ${DISPLAY_MIN_PX} px. CJK text sets every tracking token to 0 (:lang(ja|zh|ko)).
 */

:root {
${sizes}
  --pk-tracking-display: ${DISPLAY_TRACKING.display};
  --pk-tracking-heading: ${DISPLAY_TRACKING.heading};
  --pk-tracking-eyebrow: ${DISPLAY_TRACKING.eyebrow};
  --pk-tracking-product-display: ${DISPLAY_TRACKING.product};
}

/* Tracking compresses Latin letterforms; CJK glyphs are set solid, so tracking is 0. */
:lang(ja),
:lang(zh),
:lang(ko) {
  --pk-tracking-display: ${DISPLAY_TRACKING.cjk};
  --pk-tracking-heading: ${DISPLAY_TRACKING.cjk};
  --pk-tracking-eyebrow: ${DISPLAY_TRACKING.cjk};
  --pk-tracking-product-display: ${DISPLAY_TRACKING.cjk};
}

${classes}

/* The mono uppercase eyebrow: 12 px, never smaller. */
.pk-eyebrow {
  font-family: var(--pk-font-mono);
  font-weight: var(--pk-font-weight-medium);
  font-size: var(--pk-font-size-xs);
  line-height: var(--pk-line-height-xs);
  letter-spacing: var(--pk-tracking-eyebrow);
  text-transform: uppercase;
  color: var(--pk-accent-fg);
}

.pk-heading {
  font-weight: var(--pk-font-weight-semibold);
  letter-spacing: var(--pk-tracking-heading);
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
  colors.push(["action", "action"]);
  colors.push(["action-on", "action-on"]);
  for (const k of STATE_KINDS)
    colors.push([`state-${kebab(k)}`, `state-${kebab(k)}`]);
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
  lines.push(`  --font-weight-medium: var(--pk-font-weight-medium);`);
  lines.push(`  --font-weight-semibold: var(--pk-font-weight-semibold);`);
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
    motionEasingFallback: MOTION_EASING_FALLBACK,
    font: FONT,
    fontWeight: FONT_WEIGHT,
    typeScale: TYPE_SCALE,
    letterSpacing: LETTER_SPACING,
    displayScale: DISPLAY_SCALE,
    displayTracking: DISPLAY_TRACKING,
    kit: kitModel(),
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
  c("ACTION", t.action.fill);
  c("ACTION_ON", t.action.on);
  for (const [k, id, hex] of stateEntries(theme))
    c(`STATE_${upper(id)}_${upper(k)}`, hex);
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
  c("action", t.action.fill);
  c("actionOn", t.action.on);
  for (const [k, id, hex] of stateEntries(theme))
    c(`state${cap(id)}${cap(k)}`, hex);
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

    /// "Powered by" badge minimum sizes in points (CSS-pixel equivalents): never render smaller.
${(["horizontal", "compact", "stacked"] as const)
  .map((layout) => {
    const { width, height } = POWERED_BY.minimum[layout];
    const name = layout[0]!.toUpperCase() + layout.slice(1);
    return `    public static let badgeMin${name}: (width: Double, height: Double) = (${width}, ${height})`;
  })
  .join("\n")}

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

// ── Kotlin (Compose) ────────────────────────────────────────────────────────────────────────

function ktColor(hex: string): string {
  return `Color(0xFF${hex.slice(1).toUpperCase()})`;
}

const ktFloat = (n: number): string => {
  const s = String(n);
  return `${s.includes(".") || s.includes("e") ? s : `${s}.0`}f`;
};

const remToDp = (rem: string): number =>
  rem.endsWith("rem") ? Number(rem.slice(0, -3)) * 16 : Number(rem);

function ktTheme(theme: Theme): string {
  const t = T[theme];
  const out: string[] = [];
  const c = (name: string, hex: string) =>
    out.push(`        public val ${name}: Color = ${ktColor(hex)}`);
  for (const [k, x] of Object.entries(t.surface))
    c(`surface${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  for (const [k, x] of Object.entries(t.text))
    c(`text${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  for (const [k, x] of Object.entries(t.border))
    c(`border${k[0]!.toUpperCase()}${k.slice(1)}`, x);
  c("focus", t.focus);
  c("action", t.action.fill);
  c("actionOn", t.action.on);
  for (const [k, id, hex] of stateEntries(theme))
    c(`state${cap(id)}${cap(k)}`, hex);
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

/** One node of a kit SVG, reduced to what Compose's ImageVector draws: groups and filled paths. */
type SvgNode =
  | {
      kind: "group";
      tx: number;
      ty: number;
      sx: number;
      sy: number;
      fill: string | null;
      children: SvgNode[];
    }
  | { kind: "path"; fill: string | null; d: string };

function svgTransform(value: string | undefined): {
  tx: number;
  ty: number;
  sx: number;
  sy: number;
} {
  const out = { tx: 0, ty: 0, sx: 1, sy: 1 };
  if (!value) return out;
  let rest = value.trim();
  const translate = /^translate\(\s*([-\d.]+)[\s,]+([-\d.]+)\s*\)\s*/.exec(
    rest,
  );
  if (translate) {
    out.tx = Number(translate[1]);
    out.ty = Number(translate[2]);
    rest = rest.slice(translate[0].length);
  }
  const scale = /^scale\(\s*([-\d.]+)(?:[\s,]+([-\d.]+))?\s*\)\s*/.exec(rest);
  if (scale) {
    out.sx = Number(scale[1]);
    out.sy = scale[2] === undefined ? out.sx : Number(scale[2]);
    rest = rest.slice(scale[0].length);
  }
  if (rest) throw new Error(`gen: unsupported SVG transform "${value}"`);
  return out;
}

/**
 * A kit SVG as a tree of groups and filled paths. The kit marks use only `<g>` (translate, then
 * scale, and an inherited fill) and filled `<path>`; anything else fails the generator rather
 * than drawing something the kit did not.
 */
export function svgTree(svg: string): {
  width: number;
  height: number;
  nodes: SvgNode[];
} {
  const root = /<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new Error("gen: not an SVG");
  const attrs = (src: string) =>
    Object.fromEntries(
      [...src.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]),
    );
  const rootAttrs = attrs(root[1]!);
  const width = Number(rootAttrs.width);
  const height = Number(rootAttrs.height);
  if (rootAttrs.viewBox !== `0 0 ${width} ${height}`)
    throw new Error("gen: a kit SVG's viewBox must be 0 0 width height");
  const top: SvgNode[] = [];
  const stack: SvgNode[][] = [top];
  const body = svg
    .slice(root.index + root[0].length)
    .replace(/<title>[^<]*<\/title>|<desc>[^<]*<\/desc>/g, "");
  for (const m of body.matchAll(/<(\/?)([a-z]+)\b([^>]*?)(\/?)>/g)) {
    const [, close, tag, rawAttrs, selfClose] = m;
    if (tag === "svg" && close) break;
    if (tag === "g") {
      if (close) {
        stack.pop();
        continue;
      }
      const a = attrs(rawAttrs!);
      const group: SvgNode = {
        kind: "group",
        ...svgTransform(a.transform),
        fill: a.fill ?? null,
        children: [],
      };
      stack.at(-1)!.push(group);
      if (!selfClose) stack.push(group.children);
      continue;
    }
    if (tag === "path") {
      const a = attrs(rawAttrs!);
      const path: SvgNode = { kind: "path", fill: a.fill ?? null, d: a.d! };
      if (a.transform) {
        stack.at(-1)!.push({
          kind: "group",
          ...svgTransform(a.transform),
          fill: null,
          children: [path],
        });
      } else stack.at(-1)!.push(path);
      continue;
    }
    throw new Error(`gen: unsupported SVG element <${tag}>`);
  }
  return { width, height, nodes: top };
}

function ktNodes(nodes: SvgNode[], indent: string): string {
  return nodes
    .map((n) => {
      if (n.kind === "path") {
        const fill = n.fill ? ktColor(n.fill) : "null";
        return `${indent}BrandVectorNode.Path(fill = ${fill}, pathData = "${n.d}"),`;
      }
      const fill = n.fill ? ktColor(n.fill) : "null";
      return `${indent}BrandVectorNode.Group(
${indent}    translateX = ${ktFloat(n.tx)}, translateY = ${ktFloat(n.ty)}, scaleX = ${ktFloat(n.sx)}, scaleY = ${ktFloat(n.sy)}, fill = ${fill},
${indent}    children = listOf(
${ktNodes(n.children, `${indent}        `)}
${indent}    ),
${indent}),`;
    })
    .join("\n");
}

/** The kit SVGs the Compose kit draws when branding is on (PolarisBrandMarks). */
const KOTLIN_MARKS: [string, string, string][] = [
  [
    "pinnedKDark",
    "01-marks/key/svg/key-display-dark.svg",
    "The Pinned K, display cut, for dark grounds; no terminal bit.",
  ],
  [
    "pinnedKLight",
    "01-marks/key/svg/key-display-light.svg",
    "The Pinned K, display cut, for light grounds; no terminal bit.",
  ],
  [
    "poweredByCompactDark",
    "03-powered-by/transparent/powered-by-compact-dark.svg",
    'The compact "Powered by Polaris Key" badge, transparent treatment, for dark grounds.',
  ],
  [
    "poweredByCompactLight",
    "03-powered-by/transparent/powered-by-compact-light.svg",
    'The compact "Powered by Polaris Key" badge, transparent treatment, for light grounds.',
  ],
];

function ktMarks(): string {
  return KOTLIN_MARKS.map(([name, kitPath, doc]) => {
    const tree = svgTree(readFileSync(join(PKG, "kit", kitPath), "utf8"));
    return `    /** ${doc} kit/${kitPath}. */
    public val ${name}: BrandVector = BrandVector(
        width = ${ktFloat(tree.width)},
        height = ${ktFloat(tree.height)},
        nodes = listOf(
${ktNodes(tree.nodes, "            ")}
        ),
    )`;
  }).join("\n\n");
}

function kotlinSource(): string {
  const table = (theme: Theme) =>
    SERVICE_IDS.map((id) => {
      const a = serviceAccent(theme, id);
      const bit = sectionBit(theme, id);
      return `        "${id}" to BrandAccent(solid = ${ktColor(a.solid)}, fg = ${ktColor(a.fg)}, on = ${ktColor(a.on)}, subtle = ${ktColor(a.subtle)}, bit = ${bit === null ? "null" : ktColor(bit)}),`;
    }).join("\n");
  const badge = (["horizontal", "compact", "stacked"] as const)
    .map((layout) => {
      const { width, height } = POWERED_BY.minimum[layout];
      const name = layout[0]!.toUpperCase() + layout.slice(1);
      return `    public val badgeMin${name}: BrandSize = BrandSize(${ktFloat(width)}, ${ktFloat(height)})`;
    })
    .join("\n");
  const radius = Object.entries(RADIUS)
    .filter(([k]) => k !== "full")
    .map(
      ([k, v]) =>
        `        public const val ${k}: Float = ${ktFloat(remToDp(v))}`,
    )
    .join("\n");
  const motion = Object.entries(MOTION.duration)
    .map(([k, v]) => `        public const val ${k}: Int = ${parseInt(v, 10)}`)
    .join("\n");
  return `${banner("//")}

@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui.brand

import androidx.compose.ui.graphics.Color

/**
 * One section's accent in one theme: [solid] for indicators and fills, [fg] for text, [on] for
 * text on a solid fill, [subtle] for a tinted surface, [bit] for the K's terminal bit (null on
 * core: the platform draws no bit).
 */
public data class BrandAccent(
    val solid: Color,
    val fg: Color,
    val on: Color,
    val subtle: Color,
    val bit: Color?,
)

/** A size in dp (CSS-pixel equivalents). */
public data class BrandSize(val width: Float, val height: Float)

/** A kit SVG reduced to groups and filled paths, in its own coordinate space. */
public data class BrandVector(val width: Float, val height: Float, val nodes: List<BrandVectorNode>)

/** One node of a [BrandVector]. */
public sealed interface BrandVectorNode {
    /** A group: translate, then scale (the SVG order), and a fill its paths inherit. */
    public data class Group(
        val translateX: Float,
        val translateY: Float,
        val scaleX: Float,
        val scaleY: Float,
        val fill: Color?,
        val children: List<BrandVectorNode>,
    ) : BrandVectorNode

    /** A filled path in SVG path syntax; a null fill inherits the group's. */
    public data class Path(val fill: Color?, val pathData: String) : BrandVectorNode
}

/** Polaris Key brand tokens (@polaris-key/brand). Dark is the default theme. */
public object PolarisBrandTokens {
    /** Kit primitives, verbatim (kit/08-developer/tokens.json). */
    public object Kit {
        public val violetDark: Color = ${ktColor(BRAND.violet.dark)}
        public val violetLight: Color = ${ktColor(BRAND.violet.light)}
        public val goldDark: Color = ${ktColor(BRAND.gold.dark)}
        public val goldLight: Color = ${ktColor(BRAND.gold.light)}
        public val pageDark: Color = ${ktColor(BRAND.page.dark)}
        public val pageLight: Color = ${ktColor(BRAND.page.light)}
        public val starDark: Color = ${ktColor(BRAND.star.dark)}
        public val starLight: Color = ${ktColor(BRAND.star.light)}
        public val mutedDark: Color = ${ktColor(BRAND.muted.dark)}
        public val mutedLight: Color = ${ktColor(BRAND.muted.light)}
    }

    /** Optical cuts by displayed (dp) size, never pixel density. */
    public const val FAVICON_BELOW: Float = ${ktFloat(OPTICAL.faviconBelow)}
    public const val SERVICE_MAX: Float = ${ktFloat(OPTICAL.serviceMax)}
    public const val GOLD_MINIMUM_GLYPH: Float = ${ktFloat(OPTICAL.goldMinimumGlyphSize)}
    public const val CLEAR_SPACE_RATIO: Float = ${ktFloat(CLEAR_SPACE_RATIO)}
    public const val POWERED_BY_PHRASE: String = "${POWERED_BY.phrase}"

    /** "Powered by" badge minimum sizes in dp: never render smaller. */
${badge}

    /** Corner radii in dp (controls use md, cards lg, the badge frame xl). */
    public object Radius {
${radius}
    }

    /** Motion durations in milliseconds. */
    public object Duration {
${motion}
    }

    /** Section ids: core plus every service slug. */
    public val serviceIds: List<String> = listOf(${SERVICE_IDS.map((s) => `"${s}"`).join(", ")})

    /** The dark theme (default). */
    public object Dark {
${ktTheme("dark")}
    }

    /** The light theme. */
    public object Light {
${ktTheme("light")}
    }

    private val accentsDark: Map<String, BrandAccent> = mapOf(
${table("dark")}
    )

    private val accentsLight: Map<String, BrandAccent> = mapOf(
${table("light")}
    )

    /** A section's accent. Unknown ids answer the core (platform) violet. */
    public fun accent(service: String, dark: Boolean = true): BrandAccent {
        val table = if (dark) accentsDark else accentsLight
        return table[service] ?: table.getValue("core")
    }

    /** Which optical cut a mark displayed at [size] dp uses. */
    public fun opticalCut(size: Float): String = when {
        size < FAVICON_BELOW -> "favicon"
        size <= SERVICE_MAX -> "service"
        else -> "display"
    }
}

/** The kit artwork the Compose kit draws when Polaris Key branding is on. */
public object PolarisBrandMarkData {
${ktMarks()}
}
`;
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────────

interface Target {
  path: string;
  render: () => string;
  parser?: "typescript" | "json" | "css";
}

/**
 * A file copied byte for byte (binary-safe), compared as bytes by `--check`: a launch-kit file
 * (`kitPath`, under kit/) or a package file (`pkgPath`, under packages/brand/).
 */
type Copy = { path: string } & (
  | { kitPath: string; pkgPath?: never }
  | { pkgPath: string; kitPath?: never }
);

const PYTHON_UI = "sdks/python/src/polaris_key/ui";
const VARIABLE_FONTS: [string, string][] = [
  ["Rubik-Variable.ttf", "polaris_rubik_variable.ttf"],
  ["JetBrainsMono-Variable.ttf", "polaris_jetbrains_mono_variable.ttf"],
];

/**
 * The Compose kit's Rubik (P6-11): Android resource fonts must sit in res/font with lowercase
 * names, so the kit TTFs are copied there unchanged; the OFL and the kit notice travel in the
 * module's assets (a TARGET below), so they ship inside every app that bundles the fonts.
 */
const KOTLIN_UI = "sdks/kotlin/ui/src/main";
const COPIES: Copy[] = [
  {
    path: `${KOTLIN_UI}/res/font/polaris_rubik_regular.ttf`,
    kitPath: "source/fonts/Rubik-Regular.ttf",
  },
  {
    path: `${KOTLIN_UI}/res/font/polaris_rubik_bold.ttf`,
    kitPath: "source/fonts/Rubik-Bold.ttf",
  },
  // The variable Rubik and JetBrains Mono (UI-KITS.md §2.1). The static 400/700 above stay until
  // the Compose kit's typography moves to the variable face (UK-09).
  ...VARIABLE_FONTS.map(([ttf, res]) => ({
    path: `${KOTLIN_UI}/res/font/${res}`,
    pkgPath: `fonts/ttf/${ttf}`,
  })),
  // The Python wheel's fonts (polaris_key/ui/fonts), for the Qt kit.
  ...VARIABLE_FONTS.map(([ttf]) => ({
    path: `${PYTHON_UI}/fonts/${ttf}`,
    pkgPath: `fonts/ttf/${ttf}`,
  })),
];

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

/**
 * The Godot UI kit's fonts: the kit's Rubik TTFs, unchanged, as text `FontFile` resources. A
 * FontFile `.tres` needs no importer (a `.ttf` would get an `.import` file whose parameters differ
 * between engine versions), loads on 4.4 and later (base64 `PackedByteArray`, format 4), and
 * exports with the game like any resource. OFL 1.1 lets the font ship bundled with software as
 * long as its licence travels with it, so OFL.txt and the kit notice sit beside the resources.
 */
const GODOT_FONT_DIR = "sdks/godot/addons/polaris_key/ui/theme/fonts";
const GODOT_FONTS: [string, string][] = [
  ["rubik_regular.tres", "Rubik-Regular.ttf"],
  ["rubik_bold.tres", "Rubik-Bold.ttf"],
];

/** The variable fonts as MSDF FontFiles (UI-KITS.md §2.1); the statics stay until UK-11. */
const GODOT_VARIABLE_FONTS: [string, string][] = [
  ["rubik_variable.tres", "Rubik-Variable.ttf"],
  ["jetbrains_mono_variable.tres", "JetBrainsMono-Variable.ttf"],
];

const KIT_CTX: KitGenContext = {
  banner,
  cssBanner,
  bannerLines: BANNER_LINES,
  pkg: PKG,
};

/** The font licences that travel with every copy of the variable fonts. */
const FONT_LICENCES = ["OFL.txt", "OFL-JetBrainsMono.txt", "FONT-NOTICE.txt"];

/** A kit TTF as a Godot text FontFile resource, with the banner as `;` comments. */
export function godotFontTres(ttf: string): string {
  const data = readFileSync(join(PKG, "kit", "source", "fonts", ttf)).toString(
    "base64",
  );
  const lines = BANNER_LINES.map((l) =>
    l.startsWith("packages/brand/src/tokens/")
      ? `packages/brand/kit/source/fonts/${ttf}, unchanged (SIL OFL 1.1, see OFL.txt).`
      : l,
  );
  const comment = lines.map((l) => (l ? `; ${l}` : ";")).join("\n");
  return `[gd_resource type="FontFile" format=4]\n\n${comment}\n\n[resource]\ndata = PackedByteArray("${data}")\n`;
}

/** The kit SVGs the Godot UI kit draws (PKeyBrandMarks), as GDScript string constants. */
const GODOT_MARKS: [string, string][] = [
  ["PINNED_K_DARK", "01-marks/key/svg/key-display-dark.svg"],
  ["PINNED_K_LIGHT", "01-marks/key/svg/key-display-light.svg"],
  [
    "POWERED_BY_COMPACT_DARK",
    "03-powered-by/transparent/powered-by-compact-dark.svg",
  ],
  [
    "POWERED_BY_COMPACT_LIGHT",
    "03-powered-by/transparent/powered-by-compact-light.svg",
  ],
];

export function godotMarks(): string {
  const consts = GODOT_MARKS.map(([name, kitPath]) => {
    const svg = readFileSync(join(PKG, "kit", kitPath), "utf8").trim();
    return `## kit/${kitPath}, verbatim.\nconst ${name} := ${JSON.stringify(svg)}`;
  }).join("\n");
  const compact = readFileSync(
    join(PKG, "kit", "03-powered-by/transparent/powered-by-compact-dark.svg"),
    "utf8",
  );
  const width = /<svg[^>]* width="(\d+)"/.exec(compact)?.[1];
  if (!width) throw new Error("gen: the compact badge SVG has no width");
  return `${banner("#")}
class_name PKeyBrandMarks
extends RefCounted
## The kit artwork the UI kit rasterises when Polaris Key branding is on (PKeyUiTheme.branded()):
## the Pinned K's display cut without the terminal bit (BRAND.md owner decisions, 2026-10-03) and
## the compact "Powered by Polaris Key" badge, transparent treatment, for dark and light grounds.

## The compact badge's SVG width (its minimum, BADGE_MIN_COMPACT.x).
const POWERED_BY_COMPACT_WIDTH := ${width}.0
${consts}
`;
}

const TARGETS: Target[] = [
  { path: "packages/brand/css/tokens.css", render: tokensCss, parser: "css" },
  { path: "packages/brand/css/theme.css", render: themeCss, parser: "css" },
  {
    path: "packages/brand/css/marketing.css",
    render: marketingCss,
    parser: "css",
  },
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
    path: `${KOTLIN_UI}/kotlin/im/plrs/key/ui/brand/PolarisBrandTokens.generated.kt`,
    render: kotlinSource,
  },
  ...["OFL.txt", "FONT-NOTICE.txt"].map((name) => ({
    path: `${KOTLIN_UI}/assets/polaris-key/fonts/${name}`,
    render: () =>
      readFileSync(join(PKG, "kit", "source", "fonts", name), "utf8"),
  })),
  {
    path: `${GODOT_BRAND_DIR}/.gdignore`,
    render: () =>
      "# GENERATED by `pnpm gen:brand`: Godot never imports this folder (see packages/brand/scripts/gen.ts).",
  },
  ...GODOT_BRAND_ASSETS.map(([name, kitPath]) => ({
    path: `${GODOT_BRAND_DIR}/${name}`,
    render: () => godotBrandSvg(kitPath),
  })),
  {
    path: "sdks/godot/addons/polaris_key/ui/theme/brand_marks_generated.gd",
    render: godotMarks,
  },
  ...GODOT_FONTS.map(([name, ttf]) => ({
    path: `${GODOT_FONT_DIR}/${name}`,
    render: () => godotFontTres(ttf),
  })),
  ...["OFL.txt", "FONT-NOTICE.txt"].map((name) => ({
    path: `${GODOT_FONT_DIR}/${name}`,
    render: () =>
      readFileSync(join(PKG, "kit", "source", "fonts", name), "utf8"),
  })),

  // ── UI kits (docs/design/UI-KITS.md §2; scripts/gen-kit.ts) ──
  {
    path: "packages/brand/css/kit.css",
    render: () => kitCss(KIT_CTX),
    parser: "css",
  },
  {
    path: "packages/brand/src/generated/kit.ts",
    render: () => kitTs(KIT_CTX),
    parser: "typescript",
  },
  {
    path: "packages/brand/fixtures/accent-vectors.json",
    render: accentVectorsJson,
    parser: "json",
  },
  {
    path: "sdks/swift/Sources/PolarisKeyUI/KitTokens.generated.swift",
    render: () => swiftKit(KIT_CTX),
  },
  {
    path: "sdks/swift/Tests/PolarisKeyTests/AccentVectors.generated.swift",
    render: () => swiftVectors(KIT_CTX),
  },
  {
    path: `${KOTLIN_UI}/kotlin/im/plrs/key/ui/brand/PolarisKitTokens.generated.kt`,
    render: () => kotlinKit(KIT_CTX),
  },
  {
    path: "sdks/kotlin/ui/src/test/kotlin/im/plrs/key/ui/brand/AccentVectors.generated.kt",
    render: () => kotlinVectors(KIT_CTX),
  },
  ...["OFL-JetBrainsMono.txt"].map((name) => ({
    path: `${KOTLIN_UI}/assets/polaris-key/fonts/${name}`,
    render: () => readFileSync(join(PKG, "fonts", name), "utf8"),
  })),
  {
    path: "sdks/godot/addons/polaris_key/ui/theme/kit_tokens_generated.gd",
    render: () => gdKit(KIT_CTX),
  },
  {
    path: "sdks/godot/addons/polaris_key/ui/theme/kit_icons_generated.gd",
    render: () => gdIcons(KIT_CTX),
  },
  ...GODOT_VARIABLE_FONTS.map(([name, ttf]) => ({
    path: `${GODOT_FONT_DIR}/${name}`,
    render: () => godotVariableFontTres(KIT_CTX, ttf),
  })),
  {
    path: `${GODOT_FONT_DIR}/OFL-JetBrainsMono.txt`,
    render: () =>
      readFileSync(join(PKG, "fonts", "OFL-JetBrainsMono.txt"), "utf8"),
  },
  {
    path: "sdks/godot/tests/brand/accent-vectors.json",
    render: accentVectorsJson,
    parser: "json",
  },
  {
    path: "sdks/godot/addons/polaris_key/dotnet/PKeyBrand.generated.cs",
    render: () => csharpBrand(KIT_CTX),
  },
  { path: `${PYTHON_UI}/_tokens.py`, render: () => pythonTokens(KIT_CTX) },
  { path: `${PYTHON_UI}/ansi.py`, render: () => pythonAnsi(KIT_CTX) },
  { path: `${PYTHON_UI}/qt/Theme.qml`, render: () => qtQml(KIT_CTX) },
  { path: `${PYTHON_UI}/qt/qmldir`, render: qtQmldir },
  ...(["dark", "light"] as const).map((theme) => ({
    path: `${PYTHON_UI}/qt/polaris_key_${theme}.qss`,
    render: () => qtQss(KIT_CTX, theme),
  })),
  ...FONT_LICENCES.map((name) => ({
    path: `${PYTHON_UI}/fonts/${name}`,
    render: () => readFileSync(join(PKG, "fonts", name), "utf8"),
  })),
  {
    path: "sdks/python/tests/fixtures/accent-vectors.json",
    render: accentVectorsJson,
    parser: "json",
  },
  {
    path: "packages/sdk-node/src/cli/tokens.generated.ts",
    render: () => nodeTerminal(KIT_CTX),
    parser: "typescript",
  },
  // The kit copy catalog (plans/UK-02.md §3.3): web, Node, Swift, Kotlin, Godot and Python tables.
  ...KIT_COPY_TARGETS,
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

/** Every path the generator owns: the rendered targets and the byte-for-byte copies. */
export function outputPaths(): string[] {
  return [...TARGETS.map((t) => t.path), ...COPIES.map((c) => c.path)];
}

export async function run(opts: {
  check: boolean;
  root?: string;
  /** Reads a committed output (tests substitute a hand-edited copy); default: the file system. */
  read?: (abs: string) => Buffer;
}): Promise<string[]> {
  const root = opts.root ?? ROOT;
  const read = opts.read ?? ((abs: string) => readFileSync(abs));
  const stale: string[] = [];
  for (const [path, content] of await renderAll(root)) {
    const abs = join(root, path);
    let current: string | undefined;
    try {
      current = read(abs).toString("utf8");
    } catch {
      current = undefined;
    }
    if (current === content) continue;
    stale.push(path);
    if (opts.check) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  for (const copy of COPIES) {
    const abs = join(root, copy.path);
    const content = readFileSync(
      copy.kitPath !== undefined
        ? join(PKG, "kit", copy.kitPath)
        : join(PKG, copy.pkgPath),
    );
    let current: Buffer | undefined;
    try {
      current = read(abs);
    } catch {
      current = undefined;
    }
    if (current?.equals(content)) continue;
    stale.push(copy.path);
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
