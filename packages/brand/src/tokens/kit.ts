// THE DESIGN SOURCE for the UI kits' component tokens (docs/design/UI-KITS.md §2.1, §4.8): the
// measures every kit reads, per platform variant, the per-platform type scale, the highlight edge,
// the scrim and the motion mapping. `pnpm gen:brand` writes them into css/kit.css (--pk-kit-*),
// src/generated/kit.ts, tokens.json and every SDK's kit tokens; no kit hand-copies a value.
//
// Units are each platform's own: CSS px on the web, points on Apple, dp/sp on Android, effective
// pixels on Windows, logical px on GNOME, and px at 720p in Godot (the kit scales with the
// window's content scale). `CAPSULE` is a fully rounded end (SwiftUI `.capsule`, M3 `full`).
//
// The danger `solid` (white label) is not here: it is derived from the danger status colour by the
// accent resolver's white-first rule (src/accent.ts), in scripts/gen.ts.

import type { Theme } from "./source.js";

/** A fully rounded end: half the control height, whatever it is. */
export const CAPSULE = "capsule" as const;
export type Radius = number | typeof CAPSULE;

/** The platform variants a kit can render (UI-KITS §1.4, §3.1 `platform`). */
export const KIT_PLATFORMS = [
  "web",
  "ios",
  "macos",
  "android",
  "windows",
  "gnome",
  "godot",
] as const;
export type KitPlatform = (typeof KIT_PLATFORMS)[number];

/** A focus indicator: the platform's own (`system`) or a drawn ring. */
export type KitFocus =
  | "system"
  | {
      /** Ring width. */
      width: number;
      /** Gap between the control and the ring; negative draws it inside. */
      offset: number;
      /** A second, inner ring of the opposite contrast (Fluent's two-tone focus visual). */
      inner?: number;
      /** A soft glow around the ring, its blur radius (console focus in Godot). */
      glow?: number;
    };

/** A scrim behind a sheet or dialog: opacity of the scrim colour and the backdrop blur. */
export interface KitScrim {
  opacity: number;
  blur: number;
}

export interface KitComponentTokens {
  /** Control height per density; `default` is "comfortable". */
  controlHeight: {
    default: number;
    compact?: number;
    coarse?: number;
    hero?: number;
  };
  /** Control corner radius; `compact` applies at the compact control height. */
  radiusControl: { default: Radius; compact?: Radius };
  /** Surface radii by role. */
  radiusSurface: Record<string, number>;
  /** Padding inside a card or sheet. */
  cardPad: { default: number; compact?: number; fullBleed?: number };
  focus: KitFocus;
  /** Scrim per scheme; `null` where the platform draws none (macOS sheets). */
  scrim: Record<Theme, KitScrim> | null;
}

export const KIT_COMPONENTS: Record<KitPlatform, KitComponentTokens> = {
  web: {
    controlHeight: { default: 44, coarse: 48, compact: 36 },
    radiusControl: { default: 12, compact: 10 },
    radiusSurface: { card: 22, group: 16 },
    cardPad: { default: 32, fullBleed: 20 },
    focus: { width: 2, offset: 2 },
    scrim: {
      light: { opacity: 0.14, blur: 12 },
      dark: { opacity: 0.5, blur: 16 },
    },
  },
  ios: {
    controlHeight: { default: 52 },
    radiusControl: { default: CAPSULE },
    radiusSurface: { sheet: 40, floating: 40, floatingLarge: 48 },
    cardPad: { default: 20 },
    focus: "system",
    scrim: {
      light: { opacity: 0.18, blur: 0 },
      dark: { opacity: 0.32, blur: 0 },
    },
  },
  macos: {
    controlHeight: { default: 28, hero: 36 },
    radiusControl: { default: CAPSULE },
    radiusSurface: { form: 10, sheet: 18 },
    cardPad: { default: 24, compact: 22 },
    focus: "system",
    scrim: null,
  },
  android: {
    controlHeight: { default: 56 },
    radiusControl: { default: CAPSULE },
    radiusSurface: { sheet: 28, listOuter: 24, listInner: 6 },
    cardPad: { default: 24 },
    focus: { width: 2, offset: 0 },
    scrim: {
      light: { opacity: 0.32, blur: 0 },
      dark: { opacity: 0.6, blur: 0 },
    },
  },
  windows: {
    controlHeight: { default: 32 },
    radiusControl: { default: 4 },
    radiusSurface: { overlay: 8 },
    cardPad: { default: 24 },
    focus: { width: 2, offset: 0, inner: 1 },
    scrim: {
      light: { opacity: 0.3, blur: 0 },
      dark: { opacity: 0.3, blur: 0 },
    },
  },
  gnome: {
    controlHeight: { default: 34 },
    radiusControl: { default: 8 },
    radiusSurface: { dialog: 14 },
    cardPad: { default: 24 },
    focus: { width: 2, offset: -2 },
    scrim: {
      light: { opacity: 0.12, blur: 0 },
      dark: { opacity: 0.35, blur: 0 },
    },
  },
  godot: {
    controlHeight: { default: 60 },
    radiusControl: { default: 16 },
    radiusSurface: { panel: 28 },
    cardPad: { default: 44 },
    focus: { width: 3, offset: 2, glow: 8 },
    scrim: {
      light: { opacity: 0.2, blur: 0 },
      dark: { opacity: 0.42, blur: 0 },
    },
  },
};

/** The scrim colour each scheme dims with (the kit's ink, a shade deeper in dark). */
export const KIT_SCRIM_COLOR: Record<Theme, string> = {
  light: "#060912",
  dark: "#020408",
};

/**
 * The highlight: a 1 px inner top edge on raised surfaces and primaries, white at this opacity
 * (UI-KITS §1.5). Faint on dark, near-solid on light.
 */
export const KIT_HIGHLIGHT: Record<Theme, { color: string; opacity: number }> =
  {
    dark: { color: "#ffffff", opacity: 0.05 },
    light: { color: "#ffffff", opacity: 0.9 },
  };

/** The concentric rule: an inner radius is the outer radius less the inset, never below this. */
export const KIT_CONCENTRIC_MIN = 8;

/** Inner radius for a surface of radius `outer` inset by `inset` (UI-KITS §2.1). */
export function concentricRadius(outer: number, inset: number): number {
  return Math.max(KIT_CONCENTRIC_MIN, outer - inset);
}

// ── Type scale ───────────────────────────────────────────────────────────────────────────────

/** Weights in UI: 400, 500 and 600 only (UI-KITS §1.5 rule 6). */
export type KitWeight = 400 | 500 | 600;

/** One type role. Sizes in the platform's unit (web: CSS lengths as strings). */
export interface KitTypeRole {
  size: number | string;
  lineHeight: number | string;
  weight: KitWeight;
  /** Letter spacing in em. */
  tracking: number;
  family: "sans" | "mono";
}

export const KIT_TYPE_ROLES = [
  "display",
  "title",
  "body",
  "label",
  "button",
  "meta",
  "footnote",
  "code",
] as const;
export type KitTypeRoleName = (typeof KIT_TYPE_ROLES)[number];

/** The platforms with their own type scale; Windows and GNOME use their system ramps. */
export const KIT_TYPE_PLATFORMS = [
  "web",
  "ios",
  "macos",
  "android",
  "windows",
  "gnome",
  "godot",
] as const satisfies readonly KitPlatform[];

const role = (
  size: number | string,
  lineHeight: number | string,
  weight: KitWeight,
  tracking = 0,
  family: "sans" | "mono" = "sans",
): KitTypeRole => ({ size, lineHeight, weight, tracking, family });

/**
 * UI-KITS §2.1's type table. `footnote` is the smaller meta size where the table gives two (iOS
 * 13/18) and the meta size elsewhere. Windows follows the Fluent type ramp (Body 14/20, Subtitle
 * 20/28, Title 28/36, Display 40/52) and GNOME the libadwaita one (body 15/21, title-2 22/28,
 * title-1 28/34), both at the kit's 400/500/600 weights.
 */
export const KIT_TYPE_SCALE: Record<
  (typeof KIT_TYPE_PLATFORMS)[number],
  Record<KitTypeRoleName, KitTypeRole>
> = {
  web: {
    display: role("clamp(1.75rem, 1.1rem + 2.6cqi, 2.25rem)", 1.12, 600, -0.02),
    title: role("clamp(1.625rem, 1rem + 2.4cqi, 2.125rem)", 1.15, 600),
    body: role("15px", "22px", 400),
    label: role("14px", "20px", 500),
    button: role("15px", "20px", 500),
    meta: role("13px", "18px", 400),
    footnote: role("13px", "18px", 400),
    code: role("40px", "48px", 500, 0.12, "mono"),
  },
  ios: {
    display: role(34, 40, 600),
    title: role(28, 34, 600),
    body: role(17, 22, 400),
    label: role(17, 22, 500),
    button: role(17, 22, 500),
    meta: role(15, 20, 400),
    footnote: role(13, 18, 400),
    code: role(28, 34, 500, 0, "mono"),
  },
  macos: {
    display: role(26, 32, 600),
    title: role(22, 28, 600),
    body: role(13, 16, 400),
    label: role(13, 16, 500),
    button: role(13, 16, 500),
    meta: role(12, 15, 400),
    footnote: role(12, 15, 400),
    code: role(28, 34, 600, 0.06, "mono"),
  },
  android: {
    display: role(36, 44, 600),
    title: role(28, 36, 600),
    body: role(16, 24, 400),
    label: role(14, 20, 500),
    button: role(16, 24, 500),
    meta: role(14, 20, 400),
    footnote: role(14, 20, 400),
    code: role(32, 40, 500, 0.06, "mono"),
  },
  windows: {
    display: role(40, 52, 600),
    title: role(28, 36, 600),
    body: role(14, 20, 400),
    label: role(14, 20, 500),
    button: role(14, 20, 500),
    meta: role(12, 16, 400),
    footnote: role(12, 16, 400),
    code: role(28, 36, 500, 0.06, "mono"),
  },
  gnome: {
    display: role(28, 34, 600),
    title: role(22, 28, 600),
    body: role(15, 21, 400),
    label: role(15, 21, 500),
    button: role(15, 21, 500),
    meta: role(13, 18, 400),
    footnote: role(13, 18, 400),
    code: role(28, 34, 500, 0.06, "mono"),
  },
  godot: {
    display: role(36, 44, 600),
    title: role(32, 40, 600),
    body: role(18, 26, 400),
    label: role(19, 26, 500),
    button: role(19, 26, 500),
    meta: role(16, 22, 400),
    footnote: role(16, 22, 400),
    code: role(52, 60, 600, 0.06, "mono"),
  },
};

// ── Motion (UI-KITS §4.8) ────────────────────────────────────────────────────────────────────

/** Where a motion row is drawn by the kit or handed to the platform. */
export interface KitMotionStep {
  /** Duration in ms (0 where the platform owns the timing). */
  ms: number;
  /** The easing token (scales.ts MOTION.easing) or the platform curve, by name. */
  easing: string;
  /** The platform API or treatment, in words, for the kit author. */
  how: string;
}

/**
 * The rows the native kits map (UI-KITS §4.8). The web row uses the S-23 pattern names instead
 * (KIT_WEB_MOTION_PATTERNS): web motion is the shared system of notes/S-23 §6.
 */
export const KIT_MOTION_CHANGES = [
  "step",
  "sheetIn",
  "sheetOut",
  "press",
  "progress",
  "waiting",
  "success",
] as const;
export type KitMotionChange = (typeof KIT_MOTION_CHANGES)[number];

/**
 * The web rows, by S-23 pattern name (notes/S-23 §6.1): enter (was sheetIn), exit (sheetOut),
 * morph (step), press, meter (progress), skeleton (waiting), success.
 */
export const KIT_WEB_MOTION_PATTERNS = [
  "enter",
  "exit",
  "morph",
  "press",
  "meter",
  "skeleton",
  "success",
] as const;
export type KitWebMotionPattern = (typeof KIT_WEB_MOTION_PATTERNS)[number];

export const KIT_MOTION_PLATFORMS = [
  "web",
  "apple",
  "android",
  "godot",
  "qt",
  "terminal",
] as const;
export type KitMotionPlatform = (typeof KIT_MOTION_PLATFORMS)[number];

const m = (ms: number, easing: string, how: string): KitMotionStep => ({
  ms,
  easing,
  how,
});

export const KIT_MOTION: {
  web: Record<KitWebMotionPattern, KitMotionStep>;
} & Record<
  Exclude<KitMotionPlatform, "web">,
  Record<KitMotionChange, KitMotionStep>
> = {
  web: {
    enter: m(
      320,
      "enter",
      "scale 0.98 to 1 and opacity via @starting-style; scrim fades at base",
    ),
    exit: m(200, "exit", "opacity and scale 1 to 0.98; scrim fades at base"),
    morph: m(
      200,
      "standard",
      "View Transition on the card: cross-fade plus an 8 px slide",
    ),
    press: m(120, "standard", "scale 0.98"),
    meter: m(200, "standard", "width transition"),
    skeleton: m(0, "linear", "countdown ring drains linearly; 2 px shimmer"),
    success: m(320, "standard", "one check draw"),
  },
  apple: {
    step: m(
      0,
      "system",
      ".navigationTransition(.zoom) where the icon persists; matchedGeometryEffect for the icon",
    ),
    sheetIn: m(
      350,
      "smooth",
      "system sheet spring (.smooth(duration: 0.35)); macOS sheets slide from the title bar",
    ),
    sheetOut: m(0, "system", "system sheet dismissal"),
    press: m(0, "system", "system"),
    progress: m(0, "system", "system"),
    waiting: m(0, "system", "ProgressView"),
    success: m(0, "system", ".symbolEffect(.bounce) once"),
  },
  android: {
    step: m(0, "system", "AnimatedContent with the MotionScheme"),
    sheetIn: m(0, "system", "system bottom sheet"),
    sheetOut: m(0, "system", "system bottom sheet"),
    press: m(0, "system", "shape morph (M3 Expressive)"),
    progress: m(0, "system", "wavy indicator"),
    waiting: m(0, "system", "LoadingIndicator inline"),
    success: m(0, "system", "one shape morph"),
  },
  godot: {
    step: m(220, "TRANS_BACK/EASE_OUT", "Tween with overshoot <= 1.04"),
    sheetIn: m(280, "TRANS_CUBIC/EASE_OUT", "rise of 24 px plus fade"),
    sheetOut: m(160, "TRANS_CUBIC/EASE_IN", "fade"),
    press: m(
      120,
      "TRANS_CUBIC/EASE_OUT",
      "0.98 press; focus moves the ring, no scale on buttons in a row",
    ),
    progress: m(200, "TRANS_CUBIC/EASE_OUT", "Tween"),
    waiting: m(0, "linear", "countdown ring"),
    success: m(320, "TRANS_CUBIC/EASE_OUT", "one Tween"),
  },
  qt: {
    step: m(200, "OutCubic", "Behavior"),
    sheetIn: m(320, "OutCubic", "opacity and scale"),
    sheetOut: m(200, "InCubic", "opacity"),
    press: m(120, "OutCubic", "scale 0.98"),
    progress: m(200, "OutCubic", "NumberAnimation"),
    waiting: m(0, "linear", "countdown ring"),
    success: m(320, "OutCubic", "one check draw"),
  },
  terminal: {
    step: m(0, "none", "redraw in place"),
    sheetIn: m(0, "none", "n/a"),
    sheetOut: m(0, "none", "n/a"),
    press: m(0, "none", "n/a"),
    progress: m(100, "none", "redraw at <= 10 Hz"),
    waiting: m(80, "none", "braille spinner, 80 ms a frame"),
    success: m(0, "none", "a check mark printed once"),
  },
};

/** Shared motion measures (UI-KITS §4.8). */
export const KIT_MOTION_MEASURES = {
  /** Press scale. */
  pressScale: 0.98,
  /** Sheet start scale. */
  sheetScale: 0.98,
  /** Step slide distance (web, px): MOTION.distance.md. */
  stepSlide: 8,
  /** Sheet rise distance (Godot, px): MOTION.distance.xl. */
  sheetRise: 24,
  /** Godot step overshoot ceiling. */
  overshoot: 1.04,
  /** Terminal spinner frame (ms) and redraw ceiling (Hz). */
  spinnerFrameMs: 80,
  redrawHz: 10,
} as const;
