// Non-colour scales: space, radius, elevation, motion and type. Theme-independent except the
// elevation shadows, whose opacity differs per theme. Emitted by scripts/gen.ts with the colours.

/** A 4 px grid, in rem (1rem = 16px). Keys are multiples of 4 px; `0.5` is 2 px. */
export const SPACE = {
  "0": "0",
  "0.5": "0.125rem",
  "1": "0.25rem",
  "1.5": "0.375rem",
  "2": "0.5rem",
  "3": "0.75rem",
  "4": "1rem",
  "5": "1.25rem",
  "6": "1.5rem",
  "8": "2rem",
  "10": "2.5rem",
  "12": "3rem",
  "16": "4rem",
  "20": "5rem",
  "24": "6rem",
} as const;

/**
 * Corner radii. `xl` (18 px) matches the "Powered by" badge frame (`rx="18"` in
 * kit/03-powered-by/*); controls use `md`, cards `lg`.
 */
export const RADIUS = {
  none: "0",
  xs: "0.125rem",
  sm: "0.25rem",
  md: "0.375rem",
  lg: "0.625rem",
  xl: "1.125rem",
  full: "9999px",
} as const;

/**
 * Elevation. Flat-friendly: on dark the surface step (page → raised → overlay) carries the
 * layering and the shadow only grounds it; on light the shadow does more of the work. Shadows are
 * the page-ground ink, never a tinted glow.
 */
export const ELEVATION = {
  dark: {
    "0": "none",
    "1": "0 1px 2px 0 rgb(0 0 0 / 0.4)",
    "2": "0 4px 12px -2px rgb(0 0 0 / 0.5)",
    "3": "0 16px 40px -8px rgb(0 0 0 / 0.6)",
  },
  light: {
    "0": "none",
    "1": "0 1px 2px 0 rgb(6 9 18 / 0.06)",
    "2": "0 4px 12px -2px rgb(6 9 18 / 0.1)",
    "3": "0 16px 40px -8px rgb(6 9 18 / 0.16)",
  },
} as const;

/**
 * Motion. Durations collapse to 0 ms under `prefers-reduced-motion: reduce` (tokens.css does it
 * once, globally), so a consumer that animates only through these tokens respects the setting
 * with no extra code. Nothing in the brand ever animates the star.
 */
export const MOTION = {
  duration: {
    instant: "0ms",
    fast: "120ms",
    base: "200ms",
    slow: "320ms",
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    enter: "cubic-bezier(0, 0, 0, 1)",
    exit: "cubic-bezier(0.3, 0, 1, 1)",
  },
} as const;

/**
 * Type. Rubik for everything set in the brand (Bold for the wordmark and headings, Regular for the
 * secondary phrase and body); the kit ships only those two weights, so there is no medium.
 *
 * Code uses the platform monospace stack rather than a bundled font: zero bytes, the face each
 * OS's developers already read code in, and native consumers (Godot, SwiftUI) get the same
 * answer from their own system monospace. Tables of figures use Rubik with tabular figures
 * (Rubik ships the OpenType `tnum` feature), not monospace.
 */
export const FONT = {
  sans: '"Rubik", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const FONT_WEIGHT = { regular: 400, bold: 700 } as const;

/** Size / line-height pairs, rem. `sm` is the console's table and form size. */
export const TYPE_SCALE = {
  xs: ["0.75rem", "1rem"],
  sm: ["0.875rem", "1.25rem"],
  base: ["1rem", "1.5rem"],
  lg: ["1.125rem", "1.75rem"],
  xl: ["1.25rem", "1.75rem"],
  "2xl": ["1.5rem", "2rem"],
  "3xl": ["1.875rem", "2.25rem"],
  "4xl": ["2.25rem", "2.5rem"],
  "5xl": ["3rem", "1.1"],
} as const satisfies Record<string, readonly [string, string]>;

/** Heading tracking: Rubik Bold sits slightly loose at display sizes. */
export const LETTER_SPACING = { tight: "-0.015em", normal: "0" } as const;
