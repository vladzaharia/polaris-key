// The UI-kit half of the brand generator (docs/design/UI-KITS.md §2): component tokens, the type
// scale, the motion mapping, the terminal tables, the accent vectors and the per-language targets
// every kit reads. scripts/gen.ts registers each render function below as a TARGET, so
// `pnpm gen:brand -- --check` covers every file this module writes.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACCENT_INK,
  ACCENT_RULES,
  ACCENT_WHITE,
  accentSolid,
  accentSurfaces,
  deriveAccent,
  resolveAccent,
} from "../src/accent.js";
import { parseHex } from "../src/color.js";
import {
  DERIVE_VECTORS,
  RESOLVE_VECTORS,
} from "../src/tokens/accent-vectors.js";
import {
  CAPSULE,
  KIT_COMPONENTS,
  KIT_CONCENTRIC_MIN,
  KIT_HIGHLIGHT,
  KIT_MOTION,
  KIT_MOTION_MEASURES,
  KIT_PLATFORMS,
  KIT_SCRIM_COLOR,
  KIT_TYPE_PLATFORMS,
  KIT_TYPE_ROLES,
  KIT_TYPE_SCALE,
  type KitComponentTokens,
  type KitPlatform,
  type KitTypeRole,
  type Radius,
} from "../src/tokens/kit.js";
import { BRAND, KIT_VERSION } from "../src/tokens/primitives.js";
import { resolveTokens, type ResolvedTheme } from "../src/tokens/resolve.js";
import { FONT_WEIGHT, MOTION, RADIUS, SPACE } from "../src/tokens/scales.js";
import {
  SERVICE_FAMILY,
  SERVICE_IDS,
  STATUS_IDS,
  THEMES,
  type Theme,
} from "../src/tokens/source.js";
import {
  TERMINAL_LAYOUT,
  TERMINAL_SGR,
  TERMINAL_SPINNER,
  TERMINAL_SYMBOLS,
} from "../src/tokens/terminal.js";

const T = resolveTokens();

export interface KitGenContext {
  /** The GENERATED banner with a line prefix (`//`, `#`, `;`). */
  banner: (prefix: string) => string;
  /** The banner as a CSS block comment. */
  cssBanner: string;
  /** The banner lines, for formats that need their own wrapping. */
  bannerLines: readonly string[];
  /** The package root (packages/brand). */
  pkg: string;
}

// ── The model ──────────────────────────────────────────────────────────────────────────────

/** The danger `solid` behind white labels, per scheme (UI-KITS §3.3): the white-first rule. */
export function dangerSolid(theme: Theme): string {
  return accentSolid(T[theme].status.danger.fg, theme, "white");
}

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const upper = (s: string) => snake(s).toUpperCase();

/** The brand's motion durations in ms, `instant` left out (it is 0 everywhere). */
const motionDurations = (): [string, number][] =>
  Object.entries(MOTION.duration)
    .filter(([k]) => k !== "instant")
    .map(([k, v]) => [k, parseInt(v, 10)]);

/** The brand's motion distances in px (pt, dp at the kits' scale). */
const motionDistances = (): [string, number][] =>
  Object.entries(MOTION.distance).map(([k, v]) => [k, parseInt(v, 10)]);

/** One component token, flattened to a scalar: a name and a number, a capsule or a flag. */
type Flat =
  | { name: string; kind: "number"; value: number }
  | { name: string; kind: "radius"; value: Radius }
  | { name: string; kind: "bool"; value: boolean };

/**
 * A platform's component tokens as flat scalars, in a fixed order every language emits:
 * controlHeight[Variant], radiusControl[Variant], radius<Surface>, cardPad[Variant], focus*,
 * scrim*. A missing focus ring (system) and a missing scrim (none) are flags with zeros.
 */
export function flatComponents(p: KitPlatform): Flat[] {
  const c: KitComponentTokens = KIT_COMPONENTS[p];
  const out: Flat[] = [];
  const variants = <V>(
    base: string,
    rec: Record<string, V>,
    kind: "number" | "radius",
  ) => {
    for (const [k, v] of Object.entries(rec)) {
      if (v === undefined) continue;
      const name = k === "default" ? base : `${base}${cap(k)}`;
      out.push({ name, kind, value: v } as Flat);
    }
  };
  variants("controlHeight", c.controlHeight, "number");
  variants("radiusControl", c.radiusControl, "radius");
  for (const [k, v] of Object.entries(c.radiusSurface))
    out.push({ name: `radius${cap(k)}`, kind: "number", value: v });
  variants("cardPad", c.cardPad, "number");
  const ring = c.focus === "system" ? null : c.focus;
  out.push({ name: "focusSystem", kind: "bool", value: ring === null });
  out.push({ name: "focusWidth", kind: "number", value: ring?.width ?? 0 });
  out.push({ name: "focusOffset", kind: "number", value: ring?.offset ?? 0 });
  out.push({ name: "focusInner", kind: "number", value: ring?.inner ?? 0 });
  out.push({ name: "focusGlow", kind: "number", value: ring?.glow ?? 0 });
  out.push({ name: "hasScrim", kind: "bool", value: c.scrim !== null });
  for (const theme of THEMES) {
    out.push({
      name: `scrim${cap(theme)}Opacity`,
      kind: "number",
      value: c.scrim?.[theme].opacity ?? 0,
    });
    out.push({
      name: `scrim${cap(theme)}Blur`,
      kind: "number",
      value: c.scrim?.[theme].blur ?? 0,
    });
  }
  return out;
}

/** Everything the kits read, resolved: tokens.json `kit` and src/generated/kit.ts. */
export function kitModel() {
  return {
    platforms: KIT_PLATFORMS,
    components: KIT_COMPONENTS,
    typeScale: KIT_TYPE_SCALE,
    concentricMin: KIT_CONCENTRIC_MIN,
    highlight: KIT_HIGHLIGHT,
    scrimColor: KIT_SCRIM_COLOR,
    danger: Object.fromEntries(
      THEMES.map((t) => [t, { solid: dangerSolid(t), on: ACCENT_WHITE }]),
    ) as Record<Theme, { solid: string; on: string }>,
    motion: KIT_MOTION,
    motionMeasures: KIT_MOTION_MEASURES,
    accentRules: ACCENT_RULES,
    accentSurfaces: Object.fromEntries(
      THEMES.map((t) => [t, accentSurfaces(t)]),
    ) as Record<Theme, readonly string[]>,
    fonts: {
      sans: "Rubik",
      mono: "JetBrains Mono",
      weights: { regular: 400, medium: 500, semibold: 600 },
    },
    terminal: {
      sgr: TERMINAL_SGR,
      symbols: TERMINAL_SYMBOLS,
      spinner: TERMINAL_SPINNER,
      layout: TERMINAL_LAYOUT,
    },
  };
}

// ── Accent vectors ────────────────────────────────────────────────────────────────────────────

function expand(pixels: readonly (readonly number[])[]): number[] {
  const out: number[] = [];
  for (const [r, g, b, a, n] of pixels)
    for (let i = 0; i < n!; i++) out.push(r!, g!, b!, a!);
  return out;
}

/** The shared vectors, computed by src/accent.ts: fixtures/accent-vectors.json. */
export function accentVectors() {
  const derived = new Map<string, string | null>();
  const derive = DERIVE_VECTORS.map((v) => {
    const expect = deriveAccent(expand(v.pixels));
    derived.set(v.name, expect);
    return { name: v.name, note: v.note, pixels: v.pixels, expect };
  });
  const resolve = RESOLVE_VECTORS.flatMap((v) => {
    const input = v.input.startsWith("derive:")
      ? derived.get(v.input.slice("derive:".length))!
      : v.input;
    if (!input) throw new Error(`gen: vector ${v.name} derives no colour`);
    return THEMES.map((scheme) => ({
      name: v.name,
      input,
      scheme,
      expect: resolveAccent(input, scheme),
    }));
  });
  const danger = THEMES.map((scheme) => ({
    scheme,
    input: T[scheme].status.danger.fg,
    expect: dangerSolid(scheme),
  }));
  return {
    comment:
      "GENERATED by `pnpm gen:brand` from packages/brand/src/tokens/accent-vectors.ts through src/accent.ts. Every port of the accent resolver (Swift, Kotlin, GDScript, Python) must reproduce these hex values exactly (UI-KITS.md §3.3).",
    rules: ACCENT_RULES,
    white: ACCENT_WHITE,
    ink: ACCENT_INK,
    surfaces: Object.fromEntries(THEMES.map((t) => [t, accentSurfaces(t)])),
    subtleAlpha: { dark: 0.12, light: 0.1 },
    derive,
    resolve,
    danger,
  };
}

export const accentVectorsJson = () => JSON.stringify(accentVectors(), null, 2);

// ── CSS: css/kit.css ──────────────────────────────────────────────────────────────────────────

const px = (n: number) => (n === 0 ? "0" : `${n}px`);
const cssRadius = (r: Radius) => (r === CAPSULE ? "9999px" : px(r));

function cssComponentVars(p: KitPlatform): [string, string][] {
  const v: [string, string][] = [];
  for (const f of flatComponents(p)) {
    if (f.name.startsWith("scrim") || f.name === "hasScrim") continue;
    if (f.kind === "bool") {
      if (f.name === "focusSystem") continue;
      continue;
    }
    v.push([
      kebab(f.name),
      f.kind === "radius" ? cssRadius(f.value) : px(f.value),
    ]);
  }
  return v;
}

function cssTypeVars(
  p: (typeof KIT_TYPE_PLATFORMS)[number],
): [string, string][] {
  const v: [string, string][] = [];
  const unit = (x: number | string, lh = false) =>
    typeof x === "string" ? x : lh && x < 4 ? String(x) : px(x);
  for (const r of KIT_TYPE_ROLES) {
    const t: KitTypeRole = KIT_TYPE_SCALE[p][r];
    v.push([`type-${r}-size`, unit(t.size)]);
    v.push([`type-${r}-line-height`, unit(t.lineHeight, true)]);
    v.push([`type-${r}-weight`, String(t.weight)]);
    v.push([`type-${r}-tracking`, t.tracking === 0 ? "0" : `${t.tracking}em`]);
    v.push([
      `type-${r}-family`,
      t.family === "mono" ? "var(--pk-font-mono)" : "var(--pk-font-sans)",
    ]);
  }
  return v;
}

const scrimRgba = (theme: Theme, opacity: number) => {
  const { r, g, b } = parseHex(KIT_SCRIM_COLOR[theme]);
  const ch = (x: number) => Math.round(x * 255);
  return `rgb(${ch(r)} ${ch(g)} ${ch(b)} / ${opacity})`;
};

function cssThemeVars(
  theme: Theme,
  p: KitPlatform = "web",
): [string, string][] {
  const h = KIT_HIGHLIGHT[theme];
  const { r, g, b } = parseHex(h.color);
  const ch = (x: number) => Math.round(x * 255);
  const scrim = KIT_COMPONENTS[p].scrim;
  return [
    ["highlight", `rgb(${ch(r)} ${ch(g)} ${ch(b)} / ${h.opacity})`],
    ["danger-solid", dangerSolid(theme)],
    ["danger-on", ACCENT_WHITE],
    ["scrim", scrim ? scrimRgba(theme, scrim[theme].opacity) : "transparent"],
    ["scrim-blur", px(scrim?.[theme].blur ?? 0)],
  ];
}

const kitDecl = (vars: [string, string][], indent = "  ") =>
  vars.map(([k, v]) => `${indent}--pk-kit-${k}: ${v};`).join("\n");

export function kitCss(ctx: KitGenContext): string {
  const platformBlocks = KIT_PLATFORMS.filter((p) => p !== "web")
    .map((p) => {
      const scrim = KIT_COMPONENTS[p].scrim;
      const vars = [
        ...cssComponentVars(p),
        ...((KIT_TYPE_PLATFORMS as readonly string[]).includes(p)
          ? cssTypeVars(p as (typeof KIT_TYPE_PLATFORMS)[number])
          : []),
      ];
      const scrimFor = (theme: Theme): [string, string][] => [
        [
          "scrim",
          scrim ? scrimRgba(theme, scrim[theme].opacity) : "transparent",
        ],
        ["scrim-blur", px(scrim?.[theme].blur ?? 0)],
      ];
      return `[data-pk-platform="${p}"] {\n${kitDecl(vars)}\n${kitDecl(scrimFor("dark"))}\n}\n\n[data-theme="light"] [data-pk-platform="${p}"],\n[data-theme="light"][data-pk-platform="${p}"] {\n${kitDecl(scrimFor("light"))}\n}`;
    })
    .join("\n\n");
  const motion = [
    ["press-scale", String(KIT_MOTION_MEASURES.pressScale)],
    ["sheet-scale", String(KIT_MOTION_MEASURES.sheetScale)],
    ["step-slide", px(KIT_MOTION_MEASURES.stepSlide)],
  ] as [string, string][];
  return `${ctx.cssBanner}

/*
 * Polaris Key UI-kit tokens (docs/design/UI-KITS.md §2.1): the component measures, the type scale,
 * the highlight edge, the danger solid and the scrim, as --pk-kit-* custom properties. Import
 * after tokens.css; every web kit (React, elements, Vue, Svelte, Angular, Electron, Tauri) reads
 * these and never a literal.
 *
 * The web variant is the default. data-pk-platform="ios|macos|android|windows|gnome|godot" on a
 * kit root renders that platform's variant inside a webview (UI-KITS §3.1 \`platform\`).
 * data-pk-density="compact" takes the compact control height and radius; a coarse pointer takes
 * the coarse height. The theme follows tokens.css: dark first, data-theme or the OS preference.
 *
 * The selectors are zero-specificity (:where) on the kit root, so a host's own rule always wins,
 * and nothing is set on :root unless the host puts the kit there.
 */

:where(:root, :host, [data-pk-kit]) {
${kitDecl(cssComponentVars("web"))}
${kitDecl(cssTypeVars("web"))}
${kitDecl(motion)}
  --pk-kit-concentric-min: ${px(KIT_CONCENTRIC_MIN)};
}

:where(:root, :host, [data-pk-kit]),
:where([data-theme="dark"]) {
${kitDecl(cssThemeVars("dark"))}
}

@media (prefers-color-scheme: light) {
  :where(:root:not([data-theme="dark"]), :host, [data-pk-kit]:not([data-theme="dark"] *)) {
${kitDecl(cssThemeVars("light"), "    ")}
  }
}

:where([data-theme="light"]) {
${kitDecl(cssThemeVars("light"))}
}

@media (pointer: coarse) {
  :where(:root, :host, [data-pk-kit]) {
    --pk-kit-control-height: var(--pk-kit-control-height-coarse);
  }
}

:where([data-pk-density="compact"]) {
  --pk-kit-control-height: var(--pk-kit-control-height-compact);
  --pk-kit-radius-control: var(--pk-kit-radius-control-compact);
}

${platformBlocks}
`;
}

// ── TypeScript: src/generated/kit.ts ──────────────────────────────────────────────────────────

export function kitTs(ctx: KitGenContext): string {
  const m = kitModel();
  return `${ctx.banner("//")}

/**
 * Every UI-kit token, resolved (docs/design/UI-KITS.md §2.1, §3.3, §4.8): component measures per
 * platform, the type scale, the highlight, the scrim, the danger solid, the motion mapping, the
 * accent resolver's rules and the terminal tables. The ui-core theme resolver and React Native
 * read these; CSS kits read css/kit.css.
 */
export const KIT_TOKENS = ${JSON.stringify(m)} as const;

export type KitTokens = typeof KIT_TOKENS;
`;
}

// ── Swift: KitTokens.generated.swift ──────────────────────────────────────────────────────────

const swiftNum = (n: number) => {
  const s = String(n);
  return s.includes(".") || s.includes("e") ? s : `${s}`;
};
const swiftRadius = (r: Radius) =>
  r === CAPSULE ? ".capsule" : `.points(${swiftNum(r)})`;
const swiftColor = (hex: string) => `BrandColor(hex: 0x${hex.slice(1)})`;

function swiftTypeRole(t: KitTypeRole): string {
  return `KitTypeRole(size: ${swiftNum(t.size as number)}, lineHeight: ${swiftNum(t.lineHeight as number)}, weight: ${t.weight}, tracking: ${swiftNum(t.tracking)}, mono: ${t.family === "mono"})`;
}

function swiftPlatform(p: KitPlatform, name: string, doc: string): string {
  const lines = flatComponents(p).map((f) => {
    if (f.kind === "bool")
      return `        public static let ${f.name}: Bool = ${f.value}`;
    if (f.kind === "radius")
      return `        public static let ${f.name}: KitRadius = ${swiftRadius(f.value)}`;
    return `        public static let ${f.name}: Double = ${swiftNum(f.value)}`;
  });
  const type = (KIT_TYPE_PLATFORMS as readonly string[]).includes(p)
    ? KIT_TYPE_ROLES.map(
        (r) =>
          `            public static let ${r} = ${swiftTypeRole(KIT_TYPE_SCALE[p as (typeof KIT_TYPE_PLATFORMS)[number]][r])}`,
      ).join("\n")
    : "";
  return `    /// ${doc}
    public enum ${name} {
${lines.join("\n")}

        /// The type scale (points). Weights are 400, 500 and 600 only.
        public enum Typography {
${type}
        }
    }`;
}

export function swiftKit(ctx: KitGenContext): string {
  const theme = (t: Theme) => `    public enum ${cap(t)} {
        /// The 1 pt inner top edge on raised surfaces and primaries: white at this opacity.
        public static let highlight = ${swiftColor(KIT_HIGHLIGHT[t].color)}
        public static let highlightOpacity: Double = ${KIT_HIGHLIGHT[t].opacity}
        /// The danger fill behind white labels (the accent resolver's white-first rule).
        public static let dangerSolid = ${swiftColor(dangerSolid(t))}
        public static let dangerOn = ${swiftColor(ACCENT_WHITE)}
        /// The colour a scrim dims with; each platform sets its opacity.
        public static let scrimColor = ${swiftColor(KIT_SCRIM_COLOR[t])}
        /// The four surfaces the accent resolver checks contrast on: page, raised, overlay, sunken.
        public static let accentSurfaces: [BrandColor] = [${accentSurfaces(t).map(swiftColor).join(", ")}]
    }`;
  return `${ctx.banner("//")}

import Foundation

/// A corner radius: fixed points, or a capsule (half the control's height).
public enum KitRadius: Sendable, Equatable {
    case points(Double)
    case capsule
}

/// One role of a platform type scale, in points.
public struct KitTypeRole: Sendable, Equatable {
    public let size: Double
    public let lineHeight: Double
    public let weight: Int
    /// Letter spacing in em.
    public let tracking: Double
    /// Set in the kit mono (JetBrains Mono) rather than Rubik.
    public let mono: Bool
}

/// The UI-kit tokens (docs/design/UI-KITS.md §2.1) for the Apple kits: SwiftUI, UIKit and AppKit.
/// Read them as \`PolarisKit.IOS.controlHeight\`, \`PolarisKit.MacOS.Typography.title\`,
/// \`PolarisKit.Dark.dangerSolid\`. Colours are in PolarisBrand (BrandTokens.generated.swift).
public enum PolarisKit {
    /// The concentric rule: an inner radius is the outer radius less the inset, never below this.
    public static let concentricMin: Double = ${KIT_CONCENTRIC_MIN}

    /// The inner radius of a surface of radius \`outer\` inset by \`inset\`.
    public static func concentricRadius(outer: Double, inset: Double) -> Double {
        max(concentricMin, outer - inset)
    }

    /// Font families the kit bundles (Resources/Brand/fonts).
    public static let fontFamily = "Rubik"
    public static let monoFamily = "JetBrains Mono"

    /// Motion durations in seconds and distances in points (the kit's own animations; system
    /// sheets keep their springs). notes/S-23 §5; zero the durations under Reduce Motion.
    public enum Motion {
${motionDurations()
  .map(([k, ms]) => `        public static let ${k}: Double = ${ms / 1000}`)
  .join("\n")}
${motionDistances()
  .map(([k, d]) => `        public static let distance${cap(k)}: Double = ${d}`)
  .join("\n")}
        public static let pressScale: Double = ${KIT_MOTION_MEASURES.pressScale}
        public static let sheetScale: Double = ${KIT_MOTION_MEASURES.sheetScale}
    }

${theme("dark")}

${theme("light")}

${swiftPlatform("ios", "IOS", "iOS, iPadOS, visionOS and tvOS (points).")}

${swiftPlatform("macos", "MacOS", "macOS (points).")}
}
`;
}

// ── Kotlin: PolarisKitTokens.generated.kt ─────────────────────────────────────────────────────

const ktFloat = (n: number): string => {
  const s = String(n);
  return `${s.includes(".") || s.includes("e") ? s : `${s}.0`}f`;
};
const ktColor = (hex: string) => `Color(0xFF${hex.slice(1).toUpperCase()})`;
const ktRadius = (r: Radius) =>
  r === CAPSULE ? "KitRadius.Capsule" : `KitRadius.Fixed(${ktFloat(r)})`;

function ktTypeRole(t: KitTypeRole): string {
  return `KitTypeRole(size = ${ktFloat(t.size as number)}, lineHeight = ${ktFloat(t.lineHeight as number)}, weight = ${t.weight}, tracking = ${ktFloat(t.tracking)}, mono = ${t.family === "mono"})`;
}

function ktPlatform(p: KitPlatform, name: string, doc: string): string {
  const lines = flatComponents(p).map((f) => {
    if (f.kind === "bool")
      return `        public const val ${f.name}: Boolean = ${f.value}`;
    if (f.kind === "radius")
      return `        public val ${f.name}: KitRadius = ${ktRadius(f.value)}`;
    return `        public const val ${f.name}: Float = ${ktFloat(f.value)}`;
  });
  const type = KIT_TYPE_ROLES.map(
    (r) =>
      `            public val ${r}: KitTypeRole = ${ktTypeRole(KIT_TYPE_SCALE[p as (typeof KIT_TYPE_PLATFORMS)[number]][r])}`,
  ).join("\n");
  return `    /** ${doc} */
    public object ${name} {
${lines.join("\n")}

        /** The type scale (sp). Weights are 400, 500 and 600 only. */
        public object Typography {
${type}
        }
    }`;
}

export function kotlinKit(ctx: KitGenContext): string {
  const theme = (t: Theme) => `    public object ${cap(t)} {
        /** The 1 dp inner top edge on raised surfaces and primaries (white at [highlightAlpha]). */
        public val highlight: Color = ${ktColor(KIT_HIGHLIGHT[t].color)}
        public const val highlightAlpha: Float = ${ktFloat(KIT_HIGHLIGHT[t].opacity)}
        /** The danger fill behind white labels (the accent resolver's white-first rule). */
        public val dangerSolid: Color = ${ktColor(dangerSolid(t))}
        public val dangerOn: Color = ${ktColor(ACCENT_WHITE)}
        /** The colour a scrim dims with; each platform sets its opacity. */
        public val scrimColor: Color = ${ktColor(KIT_SCRIM_COLOR[t])}
    }`;
  return `${ctx.banner("//")}

@file:Suppress("MagicNumber", "MaxLineLength")

package im.plrs.key.ui.brand

import androidx.compose.ui.graphics.Color

/** A corner radius: fixed dp, or a capsule (half the control's height; M3 \`full\`). */
public sealed interface KitRadius {
    public data class Fixed(val dp: Float) : KitRadius

    public data object Capsule : KitRadius
}

/** One role of a platform type scale (sp; letter spacing in em). */
public data class KitTypeRole(
    val size: Float,
    val lineHeight: Float,
    val weight: Int,
    val tracking: Float,
    /** Set in the kit mono (JetBrains Mono) rather than Rubik. */
    val mono: Boolean,
)

/**
 * The UI-kit tokens (docs/design/UI-KITS.md §2.1) for the Compose kits: Android, and the desktop
 * variants Compose Desktop renders. Read them as \`PolarisKitTokens.Android.controlHeight\`,
 * \`PolarisKitTokens.Android.Typography.title\`, \`PolarisKitTokens.Dark.dangerSolid\`.
 */
public object PolarisKitTokens {
    /** The concentric rule: an inner radius is the outer radius less the inset, never below this. */
    public const val CONCENTRIC_MIN: Float = ${ktFloat(KIT_CONCENTRIC_MIN)}

    /** The inner radius of a surface of radius [outer] inset by [inset]. */
    public fun concentricRadius(outer: Float, inset: Float): Float = maxOf(CONCENTRIC_MIN, outer - inset)

    /** Motion durations (ms), distances (dp) and measures (notes/S-23 §5). */
    public object Motion {
${motionDurations()
  .map(([k, ms]) => `        public const val ${k}: Int = ${ms}`)
  .join("\n")}
${motionDistances()
  .map(
    ([k, d]) =>
      `        public const val distance${cap(k)}: Float = ${ktFloat(d)}`,
  )
  .join("\n")}
        public const val pressScale: Float = ${ktFloat(KIT_MOTION_MEASURES.pressScale)}
    }

${theme("dark")}

${theme("light")}

${ktPlatform("android", "Android", "Android (dp, sp).")}

${ktPlatform("windows", "Windows", "Windows 11, for Compose Desktop (effective pixels).")}

${ktPlatform("gnome", "Gnome", "GNOME, for Compose Desktop on Linux (logical pixels).")}

${ktPlatform("macos", "MacOS", "macOS, for Compose Desktop (points).")}
}
`;
}

// ── GDScript: kit_tokens_generated.gd ────────────────────────────────────────────────────────

function gdNum(n: number): string {
  const s = Number(n.toFixed(6)).toString();
  return s.includes(".") || s.includes("e") ? s : `${s}.0`;
}

function gdColor(hex: string, alpha = 1): string {
  const { r, g, b } = parseHex(hex);
  return `Color(${gdNum(r)}, ${gdNum(g)}, ${gdNum(b)}, ${gdNum(alpha)})`;
}

const gdType = (t: KitTypeRole) =>
  `{"size": ${gdNum(t.size as number)}, "line_height": ${gdNum(t.lineHeight as number)}, "weight": ${t.weight}, "tracking": ${gdNum(t.tracking)}, "mono": ${t.family === "mono"}}`;

export function gdKit(ctx: KitGenContext): string {
  const flat = flatComponents("godot")
    .map((f) => {
      if (f.kind === "bool") return `const ${upper(f.name)} := ${f.value}`;
      if (f.kind === "radius")
        return `const ${upper(f.name)} := ${f.value === CAPSULE ? "CAPSULE" : gdNum(f.value)}`;
      return `const ${upper(f.name)} := ${gdNum(f.value)}`;
    })
    .join("\n");
  const type = KIT_TYPE_ROLES.map(
    (r) => `const TYPE_${upper(r)} := ${gdType(KIT_TYPE_SCALE.godot[r])}`,
  ).join("\n");
  const motion = Object.entries(KIT_MOTION.godot)
    .map(([k, v]) => `const MOTION_${upper(k)}_MS := ${v.ms}`)
    .join("\n");
  const theme = (t: Theme) =>
    [
      `const HIGHLIGHT_${upper(t)} := ${gdColor(KIT_HIGHLIGHT[t].color, KIT_HIGHLIGHT[t].opacity)}`,
      `const DANGER_SOLID_${upper(t)} := ${gdColor(dangerSolid(t))} # ${dangerSolid(t)}`,
      `const DANGER_ON_${upper(t)} := ${gdColor(ACCENT_WHITE)}`,
      `const SCRIM_${upper(t)} := ${gdColor(KIT_SCRIM_COLOR[t], KIT_COMPONENTS.godot.scrim![t].opacity)}`,
    ].join("\n");
  return `${ctx.banner("#")}
class_name PKeyKitTokens
extends RefCounted
## The Godot kit's component tokens (docs/design/UI-KITS.md §2.1, §4.8): sizes at 720p (the kit
## scales with the window's content scale), the type scale, the motion timings, the highlight
## edge, the danger solid behind white labels and the scrim. Colours of the palette are in
## PKeyBrand (brand_tokens_generated.gd).

## A radius value meaning "fully rounded" (half the control's height).
const CAPSULE := -1.0
## The concentric rule: inner radius = outer radius - inset, never below this.
const CONCENTRIC_MIN := ${gdNum(KIT_CONCENTRIC_MIN)}

## Component measures.
${flat}

## Type scale (px at 720p). Weights are 400, 500 and 600 only.
${type}

## Font families: the bundled variable Rubik and JetBrains Mono (fonts/).
const FONT_FAMILY := "Rubik"
const MONO_FAMILY := "JetBrains Mono"
const RUBIK_VARIABLE_PATH := "res://addons/polaris_key/ui/theme/fonts/rubik_variable.tres"
const JETBRAINS_MONO_VARIABLE_PATH := "res://addons/polaris_key/ui/theme/fonts/jetbrains_mono_variable.tres"

## Motion (ms; UI-KITS §4.8).
${motion}
## Brand motion durations (ms) and distances (px at 720p; notes/S-23 §5). Zero the durations when
## reduced motion is on.
${motionDurations()
  .map(([k, ms]) => `const DURATION_${upper(k)}_MS := ${ms}`)
  .join("\n")}
${motionDistances()
  .map(([k, d]) => `const MOTION_DISTANCE_${upper(k)} := ${gdNum(d)}`)
  .join("\n")}
const PRESS_SCALE := ${gdNum(KIT_MOTION_MEASURES.pressScale)}
const SHEET_RISE := ${gdNum(KIT_MOTION_MEASURES.sheetRise)}
const OVERSHOOT := ${gdNum(KIT_MOTION_MEASURES.overshoot)}

## Theme colours the palette does not carry.
${theme("dark")}
${theme("light")}


## The inner radius of a surface of radius \`outer\` inset by \`inset\`.
static func concentric_radius(outer: float, inset: float) -> float:
\treturn maxf(CONCENTRIC_MIN, outer - inset)
`;
}

// ── GDScript: the engine control icons (kit_icons_generated.gd) ─────────────────────────────

/**
 * The Godot kit's engine control icons (checkbox, radio, toggle, chevrons, close), as SVG
 * templates on a 24-unit grid with {fg}, {bg} and {track} placeholders the kit fills from the
 * theme. Kept as strings (rasterised at run time with Image.load_svg_from_string), never as
 * imported .svg files: an import's parameters differ between engine versions.
 */
export const KIT_ICONS: Record<
  string,
  { size: [number, number]; svg: string }
> = {
  checkbox_checked: {
    size: [24, 24],
    svg: '<rect x="3" y="3" width="18" height="18" rx="6" fill="{bg}"/><path d="M7.5 12.5l3 3 6-7" fill="none" stroke="{fg}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  checkbox_unchecked: {
    size: [24, 24],
    svg: '<rect x="4" y="4" width="16" height="16" rx="5" fill="none" stroke="{fg}" stroke-width="2"/>',
  },
  radio_checked: {
    size: [24, 24],
    svg: '<circle cx="12" cy="12" r="9" fill="{bg}"/><circle cx="12" cy="12" r="4" fill="{fg}"/>',
  },
  radio_unchecked: {
    size: [24, 24],
    svg: '<circle cx="12" cy="12" r="8" fill="none" stroke="{fg}" stroke-width="2"/>',
  },
  toggle_on: {
    size: [44, 24],
    svg: '<rect x="1" y="1" width="42" height="22" rx="11" fill="{track}"/><circle cx="32" cy="12" r="8" fill="{fg}"/>',
  },
  toggle_off: {
    size: [44, 24],
    svg: '<rect x="1" y="1" width="42" height="22" rx="11" fill="{track}"/><circle cx="12" cy="12" r="8" fill="{fg}"/>',
  },
  chevron_down: {
    size: [24, 24],
    svg: '<path d="M7 10l5 5 5-5" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  chevron_up: {
    size: [24, 24],
    svg: '<path d="M7 14l5-5 5 5" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  chevron_right: {
    size: [24, 24],
    svg: '<path d="M10 7l5 5-5 5" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  chevron_left: {
    size: [24, 24],
    svg: '<path d="M14 7l-5 5 5 5" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  },
  close: {
    size: [24, 24],
    svg: '<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round"/>',
  },
  clear: {
    size: [24, 24],
    svg: '<circle cx="12" cy="12" r="9" fill="{bg}"/><path d="M9 9l6 6M15 9l-6 6" fill="none" stroke="{fg}" stroke-width="2" stroke-linecap="round"/>',
  },
};

export function gdIcons(ctx: KitGenContext): string {
  const entries = Object.entries(KIT_ICONS)
    .map(([name, { size, svg }]) => {
      const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}" height="${size[1]}" viewBox="0 0 ${size[0]} ${size[1]}">${svg}</svg>`;
      return `\t"${name}": ${JSON.stringify(doc)},`;
    })
    .join("\n");
  return `${ctx.banner("#")}
class_name PKeyKitIcons
extends RefCounted
## The Godot kit's engine control icons (docs/design/UI-KITS.md §2.1): checkbox, radio, toggle,
## chevrons, close and clear, drawn on a 24-unit grid in the kit's line weight. Each is an SVG
## template; {fg}, {bg} and {track} are filled with the theme's colours by svg(), and the kit
## rasterises the result (Image.load_svg_from_string) at the scale it needs. Strings, not imported
## .svg files, because an import's parameters differ between engine versions.

const ICONS := {
${entries}
}


## The names of every icon.
static func names() -> Array:
\treturn ICONS.keys()


## The icon's SVG with its placeholders filled. Missing colours default to \`fg\`.
static func svg(name: String, fg: Color, bg: Color = Color.TRANSPARENT, track: Color = Color.TRANSPARENT) -> String:
\tvar src: String = ICONS.get(name, "")
\tif src == "":
\t\treturn ""
\tvar hex := func(c: Color) -> String: return "#" + c.to_html(false)
\tvar out := src.replace("{fg}", hex.call(fg))
\tout = out.replace("{bg}", hex.call(bg if bg.a > 0.0 else fg))
\tout = out.replace("{track}", hex.call(track if track.a > 0.0 else fg))
\treturn out
`;
}

// ── Godot fonts: variable Rubik and JetBrains Mono as MSDF FontFiles ────────────────────────

/**
 * A variable TTF from fonts/ttf as a Godot text FontFile resource with multichannel signed
 * distance fields on (UI-KITS §2.1: focus scaling stays sharp). The kit picks a weight with a
 * FontVariation (`variation_opentype = {"wght": 500}`).
 */
export function godotVariableFontTres(ctx: KitGenContext, ttf: string): string {
  const data = readFileSync(join(ctx.pkg, "fonts", "ttf", ttf)).toString(
    "base64",
  );
  const lines = ctx.bannerLines.map((l) =>
    l.startsWith("packages/brand/src/tokens/")
      ? `packages/brand/fonts/ttf/${ttf}, unchanged (SIL OFL 1.1, see the OFL files beside it).`
      : l,
  );
  const comment = lines.map((l) => (l ? `; ${l}` : ";")).join("\n");
  return `[gd_resource type="FontFile" format=4]\n\n${comment}\n\n[resource]\ndata = PackedByteArray("${data}")\nmultichannel_signed_distance_field = true\nmsdf_pixel_range = 16\nmsdf_size = 48\n`;
}

// ── Python: polaris_key/ui/_tokens.py, ansi.py ───────────────────────────────────────────────

/** A JSON-like value as a Python literal (None, True, False; tuples never). */
export function pyLiteral(v: unknown, indent = 0): string {
  const pad = (n: number) => "    ".repeat(n);
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null))
      return `[${v.map((x) => pyLiteral(x)).join(", ")}]`;
    return `[\n${v.map((x) => `${pad(indent + 1)}${pyLiteral(x, indent + 1)},`).join("\n")}\n${pad(indent)}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  return `{\n${entries.map(([k, x]) => `${pad(indent + 1)}${JSON.stringify(k)}: ${pyLiteral(x, indent + 1)},`).join("\n")}\n${pad(indent)}}`;
}

function pyTheme(theme: Theme): Record<string, string> {
  const t: ResolvedTheme = T[theme];
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(t.surface)) out[`surface_${k}`] = x;
  for (const [k, x] of Object.entries(t.text)) out[`text_${snake(k)}`] = x;
  for (const [k, x] of Object.entries(t.border)) out[`border_${k}`] = x;
  out.focus = t.focus;
  for (const s of STATUS_IDS) {
    out[s] = t.status[s].fg;
    out[`${s}_on`] = t.status[s].on;
    out[`${s}_border`] = t.status[s].border;
    out[`${s}_subtle`] = t.status[s].subtle;
  }
  out.signed = t.signed.solid;
  out.signed_on = t.signed.on;
  out.signed_border = t.signed.border;
  out.signed_subtle = t.signed.subtle;
  out.signed_mark = t.signed.mark;
  out.brand_violet = BRAND.violet[theme];
  out.brand_gold = BRAND.gold[theme];
  out.danger_solid = dangerSolid(theme);
  out.danger_solid_on = ACCENT_WHITE;
  out.scrim_color = KIT_SCRIM_COLOR[theme];
  return out;
}

const pyComponents = (p: (typeof PY_PLATFORMS)[number]) => ({
  ...Object.fromEntries(flatComponents(p).map((f) => [snake(f.name), f.value])),
  radius_surface: KIT_COMPONENTS[p].radiusSurface[PY_SURFACE[p]]!,
});

const pyType = (p: (typeof KIT_TYPE_PLATFORMS)[number]) =>
  Object.fromEntries(
    KIT_TYPE_ROLES.map((r) => {
      const t = KIT_TYPE_SCALE[p][r];
      return [
        r,
        {
          size: t.size,
          line_height: t.lineHeight,
          weight: t.weight,
          tracking: t.tracking,
          mono: t.family === "mono",
        },
      ];
    }),
  );

/** The desktop platforms the Qt kit renders. */
const PY_PLATFORMS = ["macos", "windows", "gnome"] as const;

/** Each desktop platform's main surface radius (a sheet, an overlay, a dialog). */
const PY_SURFACE: Record<(typeof PY_PLATFORMS)[number], string> = {
  macos: "sheet",
  windows: "overlay",
  gnome: "dialog",
};

/** The QSS placeholders polaris_key.ui.qt fills (qtQss). */
export const QSS_PLACEHOLDERS = [
  "accent",
  "accent-on",
  "accent-fg",
  "accent-subtle",
  "focus",
  "control-height",
  "radius-control",
  "radius-surface",
  "card-pad",
] as const;

export function pythonTokens(ctx: KitGenContext): string {
  const services = Object.fromEntries(
    THEMES.map((t) => [
      t,
      Object.fromEntries(
        SERVICE_IDS.map((id) => {
          const a = T[t].accent[SERVICE_FAMILY[id]];
          return [
            id,
            {
              solid: a.solid,
              fg: a.fg,
              on: a.on,
              subtle: a.subtle,
              bit: id === "core" ? null : a.solid,
            },
          ];
        }),
      ),
    ]),
  );
  const motion = Object.fromEntries(
    Object.entries(MOTION.duration).map(([k, v]) => [k, parseInt(v, 10)]),
  );
  return `${ctx.banner("#")}
"""Polaris Key design tokens for the Python UI kits (Qt and the terminal).

The palette per scheme, the per-section accents, the kit component tokens and type scale for the
desktop platforms the Qt kit renders (docs/design/UI-KITS.md §2.1), the motion timings and the
accent resolver's surfaces. polaris_key.ui.accent resolves a product's accent against these.
"""

from __future__ import annotations

KIT_VERSION = ${JSON.stringify(KIT_VERSION)}

#: The palette per scheme ("dark" is the default), as lower-case "#rrggbb".
THEMES = ${pyLiteral({ dark: pyTheme("dark"), light: pyTheme("light") })}

#: Per scheme, each section's accent; "bit" is None on core, which draws no bit.
SERVICE_ACCENTS = ${pyLiteral(services)}

#: The four surfaces the accent resolver checks contrast on: page, raised, overlay, sunken.
ACCENT_SURFACES = ${pyLiteral(Object.fromEntries(THEMES.map((t) => [t, [...accentSurfaces(t)]])))}

#: The 1 px inner top edge on raised surfaces and primaries: a colour at an opacity.
HIGHLIGHT = ${pyLiteral(KIT_HIGHLIGHT)}

#: Font families (bundled in polaris_key/ui/fonts) and the weights the kits use.
FONT_FAMILY = "Rubik"
MONO_FAMILY = "JetBrains Mono"
FONT_WEIGHT = ${pyLiteral(FONT_WEIGHT)}

#: Space (px) and radius (px) scales.
SPACE = ${pyLiteral(Object.fromEntries(Object.entries(SPACE).map(([k, v]) => [k, v.endsWith("rem") ? Number(v.slice(0, -3)) * 16 : Number(v)])))}
RADIUS = ${pyLiteral(
    Object.fromEntries(
      Object.entries(RADIUS)
        .filter(([k]) => k !== "full")
        .map(([k, v]) => [
          k,
          v.endsWith("rem") ? Number(v.slice(0, -3)) * 16 : Number(v),
        ]),
    ),
  )}

#: Motion durations (ms) and measures.
MOTION_MS = ${pyLiteral(motion)}
MOTION = ${pyLiteral(Object.fromEntries(Object.entries(KIT_MOTION.qt).map(([k, v]) => [snake(k), v.ms])))}
PRESS_SCALE = ${KIT_MOTION_MEASURES.pressScale}

#: A radius meaning "fully rounded" (half the control's height).
CAPSULE = "capsule"
#: The concentric rule: inner radius = outer radius - inset, never below this.
CONCENTRIC_MIN = ${KIT_CONCENTRIC_MIN}

#: Component measures per desktop platform (px; points on macOS).
KIT = ${pyLiteral(Object.fromEntries(PY_PLATFORMS.map((p) => [p, pyComponents(p)])))}

#: The QSS placeholders polaris_key.ui.qt fills in qt/polaris_key_{dark,light}.qss, as "@pk-<name>@".
QSS_PLACEHOLDERS = ${pyLiteral([...QSS_PLACEHOLDERS])}

#: Type scale per desktop platform. Weights are 400, 500 and 600 only.
TYPE_SCALE = ${pyLiteral(Object.fromEntries(PY_PLATFORMS.map((p) => [p, pyType(p)])))}


def concentric_radius(outer: float, inset: float) -> float:
    """The inner radius of a surface of radius \`outer\` inset by \`inset\`."""
    return max(CONCENTRIC_MIN, outer - inset)
`;
}

export function pythonAnsi(ctx: KitGenContext): string {
  return `${ctx.banner("#")}
"""ANSI tables for the terminal kit (docs/design/UI-KITS.md §2.1 "Terminal").

Status roles map to the ANSI-16 palette so they follow the user's terminal theme; truecolor is used
only for the product accent, and only when COLORTERM is "truecolor" or "24bit". NO_COLOR,
\`--no-color\` and a non-TTY stdout drop every escape; TERM=dumb or \`--ascii\` selects ASCII symbols.
"""

from __future__ import annotations

#: SGR parameters per role (ESC [ <sgr> m). "accent" is the fallback without truecolor.
SGR = ${pyLiteral(TERMINAL_SGR)}

#: Symbols, Unicode and ASCII.
SYMBOLS = ${pyLiteral(TERMINAL_SYMBOLS)}

#: The waiting spinner: frames and the frame time (ms).
SPINNER = ${pyLiteral(TERMINAL_SPINNER)}

#: Layout: target width, the narrowest supported width, the rail gutter and the bar width (cells).
LAYOUT = ${pyLiteral(TERMINAL_LAYOUT)}


def sgr(role: str) -> str:
    """The escape sequence that starts \`role\`."""
    return "\\x1b[" + SGR[role] + "m"


def truecolor(hex_color: str) -> str:
    """The 24-bit foreground escape for \`hex_color\` ("#rrggbb")."""
    h = hex_color.lstrip("#")
    return "\\x1b[38;2;%d;%d;%dm" % (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
`;
}

// ── Qt: Theme.qml, qmldir and the QSS per scheme ─────────────────────────────────────────────

export function qtQml(ctx: KitGenContext): string {
  const colorKeys = Object.keys(pyTheme("dark"));
  const camel = (s: string) =>
    s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const colors = colorKeys
    .map(
      (k) =>
        `    readonly property color ${camel(k)}: dark ? "${pyTheme("dark")[k]}" : "${pyTheme("light")[k]}"`,
    )
    .join("\n");
  const pick = (f: (p: (typeof PY_PLATFORMS)[number]) => string) =>
    `platform === "macos" ? ${f("macos")} : platform === "windows" ? ${f("windows")} : ${f("gnome")}`;
  const comps = flatComponents("gnome")
    .map((f) => f.name)
    .filter((n) =>
      PY_PLATFORMS.every((p) => flatComponents(p).some((x) => x.name === n)),
    )
    .map((n) => {
      const val = (p: (typeof PY_PLATFORMS)[number]) => {
        const f = flatComponents(p).find((x) => x.name === n)!;
        if (f.kind === "bool") return String(f.value);
        if (f.kind === "radius")
          return f.value === CAPSULE ? "-1" : String(f.value);
        return String(f.value);
      };
      const type =
        flatComponents("gnome").find((x) => x.name === n)!.kind === "bool"
          ? "bool"
          : "real";
      return `    readonly property ${type} ${n}: ${pick(val)}`;
    })
    .join("\n");
  const typeRoles = KIT_TYPE_ROLES.map((r) => {
    const obj = (p: (typeof PY_PLATFORMS)[number]) => {
      const t = KIT_TYPE_SCALE[p][r];
      return `({ size: ${t.size}, lineHeight: ${t.lineHeight}, weight: ${t.weight}, tracking: ${t.tracking}, mono: ${t.family === "mono"} })`;
    };
    return `    readonly property var type${cap(r)}: ${pick(obj)}`;
  }).join("\n");
  const surface = `    readonly property real radiusSurface: ${pick((p) => String(KIT_COMPONENTS[p].radiusSurface[PY_SURFACE[p]]))}`;
  return `${ctx.banner("//")}
pragma Singleton
import QtQuick

// The Polaris Key theme for the Qt Quick kit (docs/design/UI-KITS.md §2.1, §3.2): the palette
// per scheme, the product accent (set by polaris_key.ui.qt from polaris_key.ui.accent), the
// component measures and the type scale of the platform variant. Register it with the qmldir
// beside it and read \`Theme.surfacePage\`, \`Theme.controlHeight\`, \`Theme.typeTitle.size\`.
QtObject {
    // "dark" or "light". The kit sets it from the theme's colorScheme (the OS under "system").
    property string scheme: "dark"
    readonly property bool dark: scheme !== "light"

    // "macos", "windows" or "gnome": the platform variant (UI-KITS §3.1 \`platform\`).
    property string platform: Qt.platform.os === "osx" ? "macos" : Qt.platform.os === "windows" ? "windows" : "gnome"

    // The product accent, resolved for the scheme. Ink until a product colour is set (no icon,
    // no accent: never Polaris violet by default).
    property color accent: textStrong
    property color accentOn: surfacePage
    property color accentFg: textStrong
    property color accentSubtle: surfaceSunken
    property color focusRing: accentFg

    // The palette.
${colors}

    // The highlight edge.
    readonly property color highlight: dark ? Qt.rgba(1, 1, 1, ${KIT_HIGHLIGHT.dark.opacity}) : Qt.rgba(1, 1, 1, ${KIT_HIGHLIGHT.light.opacity})

    // Type.
    readonly property string fontFamily: "Rubik"
    readonly property string monoFamily: "JetBrains Mono"
    readonly property int weightRegular: 400
    readonly property int weightMedium: 500
    readonly property int weightSemibold: 600
${typeRoles}

    // Component measures; a radius of -1 is a capsule (half the height).
${comps}
${surface}

    // Motion (ms).
    readonly property int durationFast: ${parseInt(MOTION.duration.fast, 10)}
    readonly property int durationBase: ${parseInt(MOTION.duration.base, 10)}
    readonly property int durationSlow: ${parseInt(MOTION.duration.slow, 10)}
    readonly property real pressScale: ${KIT_MOTION_MEASURES.pressScale}
}
`;
}

export const qtQmldir = () =>
  "# GENERATED by `pnpm gen:brand` (packages/brand/scripts/gen-kit.ts): do not edit by hand.\nmodule PolarisKey\nsingleton Theme 1.0 Theme.qml\n";

/**
 * The QWidget stylesheet for one scheme. The palette is baked in; the product accent and the
 * platform measures are placeholders polaris_key.ui.qt fills before applying it: @pk-accent@,
 * @pk-accent-on@, @pk-accent-fg@, @pk-accent-subtle@, @pk-focus@, @pk-control-height@,
 * @pk-radius-control@, @pk-radius-surface@ and @pk-card-pad@ (QSS_PLACEHOLDERS).
 */
export function qtQss(ctx: KitGenContext, theme: Theme): string {
  const c = pyTheme(theme);
  return `${ctx.cssBanner}

/*
 * Polaris Key QWidget stylesheet, ${theme} scheme (docs/design/UI-KITS.md §3.2 "Qt"). Object names
 * select the kit's parts (#pkTitle, #pkPrimary, #pkCard…). The @pk-* placeholders are filled by
 * polaris_key.ui.qt from the resolved product accent and the platform's kit tokens.
 */

QWidget {
  font-family: "Rubik";
  font-size: 13px;
  color: ${c.text_default};
  background: transparent;
}

QWidget#pkRoot, QDialog#pkRoot {
  background: ${c.surface_page};
}

QFrame#pkCard {
  background: ${c.surface_raised};
  border: 1px solid ${c.border_subtle};
  border-radius: @pk-radius-surface@px;
  padding: @pk-card-pad@px;
}

QLabel#pkTitle {
  color: ${c.text_strong};
  font-size: 22px;
  font-weight: 600;
}

QLabel#pkBody {
  color: ${c.text_default};
}

QLabel#pkMeta {
  color: ${c.text_subtle};
  font-size: 12px;
}

QLabel#pkCode {
  font-family: "JetBrains Mono";
  font-size: 28px;
  font-weight: 600;
  color: ${c.text_strong};
}

QLabel#pkError {
  color: ${c.danger};
}

QPushButton {
  min-height: @pk-control-height@px;
  padding: 0 16px;
  border: none;
  border-radius: @pk-radius-control@px;
  background: ${c.surface_sunken};
  color: ${c.text_strong};
  font-weight: 500;
}

QPushButton:hover {
  background: ${c.border_subtle};
}

QPushButton:focus {
  outline: none;
  border: 2px solid @pk-focus@;
}

QPushButton:disabled {
  color: ${c.text_subtle};
}

QPushButton#pkPrimary {
  background: @pk-accent@;
  color: @pk-accent-on@;
}

QPushButton#pkDanger {
  background: ${c.danger_solid};
  color: ${c.danger_solid_on};
}

QPushButton#pkLink {
  background: transparent;
  color: @pk-accent-fg@;
  padding: 0;
}

QLineEdit {
  min-height: @pk-control-height@px;
  padding: 0 12px;
  border: none;
  border-radius: @pk-radius-control@px;
  background: ${c.surface_sunken};
  color: ${c.text_strong};
  selection-background-color: @pk-accent-subtle@;
}

QLineEdit:focus {
  border: 2px solid @pk-focus@;
}

QLineEdit#pkKey {
  font-family: "JetBrains Mono";
}

QProgressBar {
  min-height: 6px;
  max-height: 6px;
  border: none;
  border-radius: 3px;
  background: ${c.border_subtle};
  text-align: center;
}

QProgressBar::chunk {
  border-radius: 3px;
  background: @pk-accent@;
}

QListView, QTreeView {
  background: ${c.surface_raised};
  border: 1px solid ${c.border_subtle};
  border-radius: @pk-radius-surface@px;
}

QListView::item:selected, QTreeView::item:selected {
  background: @pk-accent-subtle@;
  color: ${c.text_strong};
}
`;
}

// ── Terminal: packages/sdk-node/src/cli/tokens.generated.ts ─────────────────────────────────

export function nodeTerminal(ctx: KitGenContext): string {
  return `${ctx.banner("//")}

/**
 * The terminal kit's tables (docs/design/UI-KITS.md §2.1 "Terminal"): SGR parameters per role
 * (status roles in the ANSI-16 palette, so they follow the user's terminal theme; truecolor only
 * for the product accent, only when COLORTERM is truecolor or 24bit), the Unicode and ASCII
 * symbol sets, the spinner and the layout widths. NO_COLOR, \`--no-color\` and a non-TTY stdout drop
 * every escape; TERM=dumb or \`--ascii\` selects ASCII.
 */
export const TERMINAL_SGR = ${JSON.stringify(TERMINAL_SGR)} as const;

export const TERMINAL_SYMBOLS = ${JSON.stringify(TERMINAL_SYMBOLS)} as const;

export const TERMINAL_SPINNER = ${JSON.stringify(TERMINAL_SPINNER)} as const;

export const TERMINAL_LAYOUT = ${JSON.stringify(TERMINAL_LAYOUT)} as const;

export type TerminalRole = keyof typeof TERMINAL_SGR;
export type TerminalSymbol = keyof (typeof TERMINAL_SYMBOLS)["unicode"];
`;
}

// ── C#: the Godot .NET facade (PKeyBrand.generated.cs) ──────────────────────────────────────

export function csharpBrand(ctx: KitGenContext): string {
  const pascal = (s: string) =>
    cap(s.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase()));
  const csColor = (hex: string) =>
    `new BrandColor(0x${hex.slice(1).toUpperCase()})`;
  const theme = (t: Theme) => {
    const c = pyTheme(t);
    return Object.entries(c)
      .map(
        ([k, v]) =>
          `            public static readonly BrandColor ${pascal(k)} = ${csColor(v)};`,
      )
      .join("\n");
  };
  const services = (t: Theme) =>
    SERVICE_IDS.map((id) => {
      const a = T[t].accent[SERVICE_FAMILY[id]];
      return `            ["${id}"] = new BrandAccent(${csColor(a.solid)}, ${csColor(a.fg)}, ${csColor(a.on)}, ${csColor(a.subtle)}),`;
    }).join("\n");
  const csNum = (n: number) => {
    const s = String(n);
    return s.includes(".") ? `${s}f` : `${s}f`;
  };
  const flat = flatComponents("godot")
    .map((f) => {
      if (f.kind === "bool")
        return `        public const bool ${pascal(f.name)} = ${f.value};`;
      if (f.kind === "radius")
        return `        public const float ${pascal(f.name)} = ${f.value === CAPSULE ? "Capsule" : csNum(f.value)};`;
      return `        public const float ${pascal(f.name)} = ${csNum(f.value)};`;
    })
    .join("\n");
  const type = KIT_TYPE_ROLES.map((r) => {
    const t = KIT_TYPE_SCALE.godot[r];
    return `        public static readonly KitTypeRole ${pascal(r)} = new KitTypeRole(${csNum(t.size as number)}, ${csNum(t.lineHeight as number)}, ${t.weight}, ${csNum(t.tracking)}, ${t.family === "mono" ? "true" : "false"});`;
  }).join("\n");
  return `${ctx.banner("//")}

#nullable enable

using System.Collections.Generic;

namespace PolarisKey.Brand
{
    /// <summary>An sRGB brand colour; <c>Hex</c> is 0xRRGGBB.</summary>
    public readonly struct BrandColor
    {
        public readonly uint Hex;

        public BrandColor(uint hex) { Hex = hex; }

        public float R => ((Hex >> 16) & 0xFF) / 255f;
        public float G => ((Hex >> 8) & 0xFF) / 255f;
        public float B => (Hex & 0xFF) / 255f;

        public override string ToString() => "#" + Hex.ToString("x6");
#if GODOT
        public Godot.Color ToColor(float alpha = 1f) => new Godot.Color(R, G, B, alpha);
#endif
    }

    /// <summary>One section's accent in one theme.</summary>
    public readonly struct BrandAccent
    {
        public readonly BrandColor Solid, Fg, On, Subtle;

        public BrandAccent(BrandColor solid, BrandColor fg, BrandColor on, BrandColor subtle)
        {
            Solid = solid; Fg = fg; On = on; Subtle = subtle;
        }
    }

    /// <summary>One role of the type scale (px at 720p; letter spacing in em).</summary>
    public readonly struct KitTypeRole
    {
        public readonly float Size, LineHeight, Tracking;
        public readonly int Weight;
        public readonly bool Mono;

        public KitTypeRole(float size, float lineHeight, int weight, float tracking, bool mono)
        {
            Size = size; LineHeight = lineHeight; Weight = weight; Tracking = tracking; Mono = mono;
        }
    }

    /// <summary>
    /// Polaris Key brand and kit tokens for the Godot .NET facade (the C# twin of PKeyBrand and
    /// PKeyKitTokens; docs/design/UI-KITS.md §2.1). Dark is the default scheme.
    /// </summary>
    public static class PKeyBrand
    {
        public static class Dark
        {
${theme("dark")}
        }

        public static class Light
        {
${theme("light")}
        }

        private static readonly Dictionary<string, BrandAccent> AccentsDark = new Dictionary<string, BrandAccent>
        {
${services("dark")}
        };

        private static readonly Dictionary<string, BrandAccent> AccentsLight = new Dictionary<string, BrandAccent>
        {
${services("light")}
        };

        /// <summary>A section's accent; unknown ids answer core.</summary>
        public static BrandAccent ServiceAccent(string service, bool dark = true)
        {
            var table = dark ? AccentsDark : AccentsLight;
            return table.TryGetValue(service, out var accent) ? accent : table["core"];
        }
    }

    /// <summary>The Godot kit's component tokens, type scale and motion (px at 720p, ms).</summary>
    public static class PKeyKitTokens
    {
        /// <summary>A radius meaning "fully rounded" (half the control's height).</summary>
        public const float Capsule = -1f;
        public const float ConcentricMin = ${csNum(KIT_CONCENTRIC_MIN)};

${flat}

${type}

${Object.entries(KIT_MOTION.godot)
  .map(([k, v]) => `        public const int Motion${pascal(k)}Ms = ${v.ms};`)
  .join("\n")}

        public static float ConcentricRadius(float outer, float inset) => System.Math.Max(ConcentricMin, outer - inset);
    }
}
`;
}

// ── Swift and Kotlin test vectors ─────────────────────────────────────────────────────────────

export function swiftVectors(ctx: KitGenContext): string {
  const v = accentVectors();
  const derive = v.derive
    .map(
      (d) =>
        `        DeriveVector(name: "${d.name}", pixels: [${d.pixels.map((p) => `[${p.join(", ")}]`).join(", ")}], expect: ${d.expect === null ? "nil" : `"${d.expect}"`}),`,
    )
    .join("\n");
  const resolve = v.resolve
    .map(
      (r) =>
        `        ResolveVector(name: "${r.name}", input: "${r.input}", dark: ${r.scheme === "dark"}, solid: "${r.expect.solid}", on: "${r.expect.on}", fg: "${r.expect.fg}", subtle: "${r.expect.subtle}", focus: "${r.expect.focus}"),`,
    )
    .join("\n");
  const danger = v.danger
    .map(
      (d) =>
        `        DangerVector(dark: ${d.scheme === "dark"}, input: "${d.input}", solid: "${d.expect}"),`,
    )
    .join("\n");
  return `${ctx.banner("//")}
//
// The accent resolver's shared vectors (packages/brand/fixtures/accent-vectors.json) as Swift
// literals for AccentResolverTests.

struct DeriveVector {
    let name: String
    let pixels: [[Int]]
    let expect: String?
}

struct ResolveVector {
    let name: String
    let input: String
    let dark: Bool
    let solid: String
    let on: String
    let fg: String
    let subtle: String
    let focus: String
}

struct DangerVector {
    let dark: Bool
    let input: String
    let solid: String
}

enum AccentVectors {
    static let derive: [DeriveVector] = [
${derive}
    ]

    static let resolve: [ResolveVector] = [
${resolve}
    ]

    static let danger: [DangerVector] = [
${danger}
    ]
}
`;
}

export function kotlinVectors(ctx: KitGenContext): string {
  const v = accentVectors();
  const derive = v.derive
    .map(
      (d) =>
        `        DeriveVector("${d.name}", listOf(${d.pixels.map((p) => `intArrayOf(${p.join(", ")})`).join(", ")}), ${d.expect === null ? "null" : `"${d.expect}"`}),`,
    )
    .join("\n");
  const resolve = v.resolve
    .map(
      (r) =>
        `        ResolveVector("${r.name}", "${r.input}", ${r.scheme === "dark"}, "${r.expect.solid}", "${r.expect.on}", "${r.expect.fg}", "${r.expect.subtle}", "${r.expect.focus}"),`,
    )
    .join("\n");
  const danger = v.danger
    .map(
      (d) =>
        `        DangerVector(${d.scheme === "dark"}, "${d.input}", "${d.expect}"),`,
    )
    .join("\n");
  return `${ctx.banner("//")}
//
// The accent resolver's shared vectors (packages/brand/fixtures/accent-vectors.json) as Kotlin
// literals for AccentResolverTest.

@file:Suppress("MaxLineLength")

package im.plrs.key.ui.brand

internal data class DeriveVector(val name: String, val pixels: List<IntArray>, val expect: String?)

internal data class ResolveVector(
    val name: String,
    val input: String,
    val dark: Boolean,
    val solid: String,
    val on: String,
    val fg: String,
    val subtle: String,
    val focus: String,
)

internal data class DangerVector(val dark: Boolean, val input: String, val solid: String)

internal object AccentVectors {
    val derive: List<DeriveVector> = listOf(
${derive}
    )

    val resolve: List<ResolveVector> = listOf(
${resolve}
    )

    val danger: List<DangerVector> = listOf(
${danger}
    )
}
`;
}
