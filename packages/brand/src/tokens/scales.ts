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
 * Motion (notes/S-23 §5; BRAND.md §7.5). Every duration and the stagger step collapse to 0 ms
 * under `prefers-reduced-motion: reduce` and under `:root[data-motion="reduce"]` (the in-app
 * preference): tokens.css does it once, globally, so a consumer that animates only through these
 * tokens swaps instantly with no extra code (S-23 D3). Delays are not motion and never collapse:
 * a skeleton still waits `delay.skeleton`, a new row keeps its tint for `delay.highlight`.
 * Nothing in the brand ever animates the star.
 *
 * No `quick` step (S-23 D4): exits use `fast`.
 */
export const MOTION = {
  duration: {
    instant: "0ms",
    /** Press in, hover colours, the fade-through gap, leaving rows. */
    micro: "80ms",
    /** Exits, popovers, the old view leaving. */
    fast: "120ms",
    /** Route and tab fade-through, list moves, overlay scrim. */
    base: "200ms",
    /** Morph (dialog or card size), expand, check draw (SIGN-IN.md §3.18's name and value). */
    moderate: "260ms",
    /** Dialog and drawer enter, shared-element morph, pill pop. */
    slow: "320ms",
    /** Success burst, count-up, highlight fade; never blocks input. */
    deliberate: "480ms",
    /** The skeleton sweep period: a loading indicator, the one sanctioned loop besides the spinner. */
    shimmer: "1600ms",
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    enter: "cubic-bezier(0, 0, 0, 1)",
    exit: "cubic-bezier(0.3, 0, 1, 1)",
    /** Shared elements, drawer, sheet, meters. */
    emphasized: "cubic-bezier(0.05, 0.7, 0.1, 1)",
    /**
     * A damped spring with a 4 % overshoot (the UI-KITS overshoot ceiling, 1.04): press release,
     * pill pop. Where `linear()` is unsupported, tokens.css falls back to MOTION_EASING_FALLBACK.
     */
    spring:
      "linear(0, 0.009, 0.035 2.1%, 0.141 4.4%, 0.723 12.9%, 0.938 16.7%, 1.017 20.5%, 1.043 24.5%, 1.035 28.4%, 1.007 36%, 0.998 42.4%, 1)",
  },
  /** Hover lift (xs), enter rise (sm), exit and step slide (md), entering view (lg), sheet rise (xl). */
  distance: {
    xs: "2px",
    sm: "4px",
    md: "8px",
    lg: "12px",
    xl: "24px",
  },
  /** `:active` (press), overlay enter (enter), pill and chip pop (pop). */
  scale: {
    press: 0.98,
    enter: 0.98,
    pop: 0.9,
  },
  /** stagger-list: 30 ms a step, at most 6 steps (180 ms, under `base`). */
  stagger: {
    step: "30ms",
    max: 6,
  },
  /** Not motion: these survive reduced motion. */
  delay: {
    /** Skeleton grace, so a fast response never flashes one. */
    skeleton: "150ms",
    /** How long a new or changed row keeps its tint. */
    highlight: "1600ms",
  },
} as const;

/** Easings that need a fallback where the browser lacks the syntax (`linear()`). */
export const MOTION_EASING_FALLBACK = {
  spring: MOTION.easing.standard,
} as const;

/**
 * Type. Rubik for everything set in the brand, as one variable face (wght 300–900; UI-KITS.md §2.1).
 * UI uses three weights: 400 (body), 500 (labels, buttons) and 600 (headings); 700 is the
 * wordmark's and a game wordmark fallback's only.
 *
 * Code, keys, user codes and hashes use the kit mono, JetBrains Mono (variable, 400–600), so a key
 * reads the same on every OS; the platform monospace stack follows it. Tables of figures use Rubik
 * with tabular figures (`tnum`), not monospace. Each family names its metric-matched fallback face
 * (fonts/fonts.css) second, so a page does not shift while the web font loads.
 */
export const FONT = {
  sans: '"Rubik", "Rubik Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: '"JetBrains Mono", "JetBrains Mono Fallback", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

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

/** Heading tracking: Rubik sits slightly loose at display sizes. */
export const LETTER_SPACING = { tight: "-0.015em", normal: "0" } as const;

/**
 * Display scale (B7, B11). Display type exists for marketing and the docs landing only; the
 * console never sets an h1 at display size. Sizes start at 40 px: the product tracking floor
 * (`DISPLAY_TRACKING.product`, -0.02em) applies only from that size up, and below it tracking
 * stays at 0 (`normal`). Each entry is [font-size, line-height]. The viewport-fluid marketing
 * ramp clamps between the first and last of these steps.
 */
export const DISPLAY_SCALE = {
  sm: ["2.5rem", "1.1"],
  md: ["3.5rem", "1.05"],
  lg: ["4.5rem", "1.02"],
  xl: ["6rem", "1"],
} as const satisfies Record<string, readonly [string, string]>;

/** The smallest displayed size (px) at which any display tracking is allowed. */
export const DISPLAY_MIN_PX = 40;

/**
 * Display and heading tracking. `product` is the most negative tracking the product may use
 * (-0.02em, from 40 px up). `marketing` takes the site's values; CJK text sets tracking 0 in both.
 */
export const DISPLAY_TRACKING = {
  product: "-0.02em",
  display: "-0.03em",
  heading: "-0.015em",
  eyebrow: "0.08em",
  cjk: "0",
} as const;
