// Brand primitives: the launch kit's values, verbatim. Source of truth:
// kit/08-developer/tokens.json (colours, size thresholds) and kit/README.md ("Colour and
// background selection", "Three optical sizes", "Powered by badges"). test/kit-fidelity.test.ts
// asserts every value here equals the kit file, so a kit update that changes one fails loudly
// instead of drifting.
//
// "dark" means FOR dark backgrounds and "light" means FOR light backgrounds (kit README), not the
// colour of the ink.

export const KIT_VERSION = "1.0.0" as const;

/**
 * The two identities in the kit. The kit labels the Star Cut "Star Cut Update" / "Polaris Key
 * Update"; on our surfaces it is the "Polaris Key Delivery" service mark (owner decision,
 * 2026-10-03; docs/design/BRAND.md §1.1). The `update` key stays the kit's name for the glyph.
 */
export const MARKS = {
  /** The platform mark, "Polaris Key". Gold is the signing bit. */
  key: { name: "Pinned K", alt: "Polaris Key" },
  /** The service mark for the delivery family (the bytes host, Distribution, Update). */
  update: { name: "Star Cut", alt: "Polaris Key Delivery" },
} as const;

export type MarkKind = keyof typeof MARKS;

/**
 * Which lockup: the kit's two (`key`, and `update`, the kit's "Polaris Key Update" original),
 * or `delivery`, the Star Cut with the "Polaris Key Delivery" wordmark our surfaces use.
 */
export type LockupKind = MarkKind | "delivery";

/** Ground the artwork sits on. */
export type Ground = "dark" | "light";

export const BRAND = {
  violet: { dark: "#9a5cff", light: "#7a2fff" },
  gold: { dark: "#ffc24d", light: "#d07a00" },
  page: { dark: "#060912", light: "#f6f8ff" },
  star: { dark: "#ffffff", light: "#7a2fff" },
  /** Reserved for optional display treatments. Never a UI accent, never in a mark. */
  rose: { dark: "#ff6fa6", light: "#e0348a" },
  /** Wordmark and primary text ink. */
  text: { dark: "#ffffff", light: "#060912" },
  /** The secondary phrase ("Powered by") and soft text; `--polaris-key-star-soft` in tokens.css. */
  muted: { dark: "#dbe4ff", light: "#48536b" },
  /** mono-black ink is the dark page ground; mono-white ink is pure white. */
  mono: { black: "#060912", white: "#ffffff" },
} as const;

/** Optical cuts, by DISPLAYED (CSS) size, never device pixel ratio. */
export const OPTICAL = {
  /** Below this displayed size, use the favicon cut (drawn on a 16-unit grid). */
  faviconBelow: 24,
  /** The favicon cut's grid; use it at 16 px (browser tabs, the Godot editor). */
  faviconCut: 16,
  /** The open service cut (24-unit grid) is for 24–32 px; the kit's minimum non-favicon size. */
  minimumServiceSize: 24,
  /** At or below this size, the service cut; above it, the display master (96-unit grid). */
  serviceMax: 32,
  /** Gold appears on the K's terminal bit only when the rendered glyph is at least this size. */
  goldMinimumGlyphSize: 48,
} as const;

/** Grid of each optical cut, in SVG user units. */
export const CUT_GRID = { favicon: 16, service: 24, display: 96 } as const;

export type OpticalCut = keyof typeof CUT_GRID;

/** "Powered by Polaris Key" badges: the exact phrase and the CSS-pixel minimums. */
export const POWERED_BY = {
  phrase: "Powered by Polaris Key",
  minimum: {
    horizontal: { width: 376, height: 144 },
    compact: { width: 232, height: 88 },
    stacked: { width: 288, height: 336 },
  },
} as const;

export type BadgeLayout = keyof typeof POWERED_BY.minimum;

/**
 * The trimmed horizontal lockup (`lockupSvg({ trim: true })`, for the 64 px console header): the
 * kit's horizontal canvas without its margin. The glyph keeps its place and size, so the
 * glyph-to-wordmark gap and ratio are the kit's byte for byte; only the canvas is cropped to the
 * glyph's 96-unit box on the left, top and bottom and to the wordmark's end on the right. Clear
 * space is the host's (8 px around the 48 px glyph in a 64 px header). test/lockup-trim.test.ts
 * proves these numbers against every horizontal template.
 */
export const LOCKUP_TRIM = { x: 16, y: 32, height: 96, right: 40 } as const;

/** Clear space around standalone marks and lockups, as a fraction of the glyph height. */
export const CLEAR_SPACE_RATIO = 0.25;

/**
 * Accessible names. `key`, `update` and `poweredBy` are the kit's (README "General use");
 * `update` names only the kit's own Update files. Our surfaces name the Star Cut `delivery`.
 */
export const ALT = {
  key: "Polaris Key",
  update: "Polaris Key Update",
  delivery: "Polaris Key Delivery",
  poweredBy: "Powered by Polaris Key",
} as const;

/** Typefaces the kit sets its type in. */
export const TYPEFACE = {
  wordmark: { family: "Rubik", weight: 700 },
  secondary: { family: "Rubik", weight: 400 },
} as const;
