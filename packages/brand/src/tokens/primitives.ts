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
 * Polaris Locker, the customer-facing subbrand (docs/design/BRAND.md §15): a third mark with its
 * own two-cut rule, outside the kit's Key / Star Cut pair. Source: locker-kit/ (the Locker
 * launch kit), checked by test/locker-fidelity.test.ts.
 */
export const LOCKER_MARK = {
  name: "Compact bookends",
  alt: "Polaris Locker",
} as const;

/** Every mark `markSvg`, `lockupSvg` and the React components draw. */
export type AnyMarkKind = MarkKind | "locker";

/**
 * Which lockup: the kit's two (`key`, and `update`, the kit's "Polaris Key Update" original),
 * or `delivery`, the Star Cut with the "Polaris Key Delivery" wordmark our surfaces use.
 */
export type LockupKind = AnyMarkKind | "delivery";

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

/**
 * Locker has two cuts, not three (locker-kit/README.md: "Use the micro source below 24 CSS px").
 * `micro` is drawn on a 16-unit grid, `master` on a 128-unit grid.
 */
export const LOCKER_OPTICAL = { microBelow: 24 } as const;
export const LOCKER_CUT_GRID = { micro: 16, master: 128 } as const;
export type LockerCut = keyof typeof LOCKER_CUT_GRID;

/**
 * The Locker palette, verbatim from locker-kit/tokens/locker.tokens.json. Grounds equal Key's
 * (`page`, `surface`, `text`, `muted`); only `accent` and `onAccent` are new. Locker coral is an
 * identity colour, never a status and never a primary fill (BRAND.md §15, D9).
 */
export const LOCKER = {
  accent: { dark: "#ff7869", light: "#c44438" },
  onAccent: { dark: "#060912", light: "#ffffff" },
  /** v1.3: the 3:1 boundary of a control. Reference only; Key's `border.strong` is the role. */
  controlBoundary: { dark: "#61697b", light: "#7e8699" },
  page: { dark: "#060912", light: "#f6f8ff" },
  surface: { dark: "#0d111b", light: "#ffffff" },
  text: { dark: "#dbe4ff", light: "#262d40" },
  muted: { dark: "#b5bed3", light: "#48536b" },
} as const;

/** Grid of each optical cut, in SVG user units. */
export const CUT_GRID = { favicon: 16, service: 24, display: 96 } as const;

export type OpticalCut = keyof typeof CUT_GRID;

/**
 * "Powered by Polaris Locker" (LK-00 §14.2, UI-KITS §1.6): the exact phrase, the one badge's
 * CSS-pixel minimum (the kit's 320 × 104 canvas) and the size of the Locker micro mark in the line.
 */
export const POWERED_BY = {
  phrase: "Powered by Polaris Locker",
  minimum: { width: 320, height: 104 },
  /** The line: the micro mark's displayed size in CSS px (the micro cut, below 24). */
  markSize: 16,
} as const;

/**
 * The Key "Powered by Polaris Key" badges (kit/03-powered-by): platform references only, not
 * offered to integrators (LK-00 §14.2). The exact phrase and the CSS-pixel minimums.
 */
export const KEY_POWERED_BY = {
  phrase: "Powered by Polaris Key",
  minimum: {
    horizontal: { width: 376, height: 144 },
    compact: { width: 232, height: 88 },
    stacked: { width: 288, height: 336 },
  },
} as const;

export type BadgeLayout = keyof typeof KEY_POWERED_BY.minimum;

/**
 * The trimmed horizontal lockup (`lockupSvg({ trim: true })`, for the 64 px console header): the
 * kit's horizontal canvas without its margin. The glyph keeps its place and size, so the
 * glyph-to-wordmark gap and ratio are the kit's byte for byte; only the canvas is cropped to the
 * glyph's 96-unit box on the left, top and bottom and to the wordmark's end on the right. Clear
 * space is the host's (8 px around the 48 px glyph in a 64 px header). test/lockup-trim.test.ts
 * proves these numbers against every horizontal template.
 */
export const LOCKUP_TRIM = { x: 16, y: 32, height: 96, right: 40 } as const;

/**
 * The Locker horizontal lockup's proportions (docs/design/BRAND.md §1.4, owner 2026-10-27): the
 * mark is `markToCap` x the wordmark's cap height (never more than `markToCapMax`), centred on the
 * cap height, with `gapToMark` x the mark's height between mark and wordmark. The kit's own file
 * has the mark at 2.5 x the cap height, which makes the name read small; `lockerLockupTemplate`
 * re-lays the kit's outlined artwork to this rule (nothing is redrawn) and `kitLockupSvg` keeps the
 * kit's file byte for byte. The Key lockups hold the same rule (the compact lockup is 1.54 x).
 */
export const LOCKUP_PROPORTION = {
  markToCap: 1.5,
  markToCapMax: 1.7,
  gapToMark: 0.35,
} as const;

/**
 * The kit's Locker horizontal geometry, in its 460 x 128 canvas: the mark art (x 8..120, y
 * 23.67..102, measured in Chromium), the wordmark's baseline, scale and first-glyph ink edge, and
 * the end of the outlined "Polaris Locker" (x 443).
 */
export const LOCKER_KIT_HORIZONTAL = {
  markX: 8,
  markY: 23.67,
  markWidth: 112,
  markHeight: 78.33,
  baseline: 80,
  textScale: 0.044,
  /** Cap height of the outlined P, in font units (the glyph is 700 high). */
  capUnits: 700,
  /** Left side bearing of the P, in font units. */
  bearingUnits: 78.15625,
  textX: 144,
  inkRight: 443,
} as const;

const K = LOCKER_KIT_HORIZONTAL;
const capHeight = K.capUnits * K.textScale;
const markScale = (capHeight * LOCKUP_PROPORTION.markToCap) / K.markHeight;
const markH = K.markHeight * markScale;
const markW = K.markWidth * markScale;
const markTop = K.baseline - capHeight / 2 - markH / 2;
const inkLeft = K.markX + markW + LOCKUP_PROPORTION.gapToMark * markH;
const textX = inkLeft - K.bearingUnits * K.textScale;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The re-laid Locker horizontal lockup: the mark scaled to 1.5 x the cap height and centred on it,
 * the wordmark pulled up to a gap of 0.35 x the mark. `markTransform` and `textX` are what
 * `lockerLockupTemplate` writes into the kit's body.
 */
export const LOCKER_HORIZONTAL = {
  /** The kit's mark scale in the re-laid lockup (0.59: 128 grid units draw 75.5). */
  markScale,
  markTransform: `translate(${r2(K.markX - K.markX * markScale)} ${r2(markTop - K.markY * markScale)}) scale(${r2(markScale * 1e4) / 1e4})`,
  textX: r2(textX),
  /** Cap height of the wordmark over the lockup's height: size a lockup by its wordmark with it. */
  capToHeight: capHeight / markH,
} as const;

/**
 * The trimmed Locker horizontal lockup (`lockupSvg({ kind: "locker", trim: true })`): the re-laid
 * lockup cropped to the mark's art on the left, top and bottom and to the end of the outlined
 * "Polaris Locker" on the right, so `height` is the mark's height and the wordmark's cap height is
 * 0.667 of it (a 23 px lockup sets the name at about 22 px). The host supplies the clear space
 * (guide p.7: at least a quarter of the glyph height).
 */
export const LOCKER_TRIM = {
  x: K.markX,
  y: r2(markTop),
  width: r2(K.inkRight + 2 - K.markX - (K.textX - textX)),
  height: r2(markH),
} as const;

/** Clear space around standalone marks and lockups, as a fraction of the glyph height. */
export const CLEAR_SPACE_RATIO = 0.25;

/**
 * Accessible names. `key`, `update` and `keyPoweredBy` are the Key kit's (README "General use");
 * `poweredBy` is the Locker attribution (the public one);
 * `update` names only the kit's own Update files. Our surfaces name the Star Cut `delivery`.
 */
export const ALT = {
  key: "Polaris Key",
  update: "Polaris Key Update",
  delivery: "Polaris Key Delivery",
  poweredBy: "Powered by Polaris Locker",
  keyPoweredBy: "Powered by Polaris Key",
} as const;

/** Typefaces the kit sets its type in. */
export const TYPEFACE = {
  wordmark: { family: "Rubik", weight: 700 },
  secondary: { family: "Rubik", weight: 400 },
} as const;
