// THE DESIGN SOURCE for every semantic colour. Edit here, then run
// `pnpm --filter @polaris-key/brand gen`: the generator resolves each OKLCH value to sRGB hex
// (scripts/gen.ts) and writes the CSS, Tailwind, TypeScript, JSON, GDScript and Swift outputs.
// `gen -- --check` fails CI when an output is stale.
//
// Colours are designed in OKLCH (perceptual lightness, chroma, hue) and emitted as hex. A value
// is either an `oklch(l, c, h)` triple or a literal hex taken from the kit's primitives
// (BRAND.*), so the kit's own colours are never re-derived through a round trip.
//
// The constraints every value here must satisfy are encoded as tests (test/contrast.test.ts,
// test/accents.test.ts) and explained in docs/design/BRAND.md. Briefly:
//   * dark first, on the kit's page ground #060912; full light parity on #f6f8ff;
//   * text tokens clear 4.5:1 on every surface of their theme; UI tokens (borders that bound a
//     control, focus, accent "solid", status borders, the signed indicator) clear 3:1;
//   * no accent or status colour is blue or indigo, none is rose (reserved for display), and none
//     is confusable with the gold signing bit; info is violet, never blue;
//   * neutrals carry the kit's own cool ground tint (#060912 / #f6f8ff / #48536b / #dbe4ff are
//     all tinted at OKLCH hue ~267–273) at low chroma; that tint is the kit's, not a blue accent.

import { BRAND } from "./primitives.js";

/** An OKLCH design value: lightness 0..1, chroma, hue in degrees. */
export interface OklchSpec {
  readonly oklch: readonly [l: number, c: number, h: number];
}

/** A colour source: an OKLCH design value or a literal kit hex. */
export type ColorSpec = OklchSpec | string;

const oklch = (l: number, c: number, h: number): OklchSpec => ({
  oklch: [l, c, h],
});

/** The cool hue the kit tints its neutrals with (#060912 sits at OKLCH h≈267). */
const NEUTRAL_HUE = 268;

export type Theme = "dark" | "light";
export const THEMES = ["dark", "light"] as const satisfies readonly Theme[];

// ── Services ────────────────────────────────────────────────────────────────────────────────

/**
 * Every section that carries an accent: `core` (the platform; not a service, and has no row in
 * tools/services.json) plus one entry per service slug in tools/services.json, in that table's
 * order. test/services.test.ts fails if the table gains a slug this list lacks.
 */
export const SERVICE_IDS = [
  "core",
  "license",
  "config",
  "release",
  "distribution",
  "update",
  "identity",
  "sync",
] as const;

export type ServiceId = (typeof SERVICE_IDS)[number];

/**
 * Accent families, one per section (owner decisions 2026-10-03, BRAND.md §5): Distribution green
 * and Update tangerine no longer share one; Config is yellow; Release, the only blue-green left,
 * takes the cyan its measured optimum lands on.
 */
export const ACCENT_FAMILIES = [
  "violet",
  "chartreuse",
  "yellow",
  "cyan",
  "green",
  "tangerine",
  "orchid",
  "teal",
] as const;

export type AccentFamily = (typeof ACCENT_FAMILIES)[number];

export const SERVICE_FAMILY: Record<ServiceId, AccentFamily> = {
  core: "violet",
  license: "chartreuse",
  config: "yellow",
  release: "cyan",
  distribution: "green",
  update: "tangerine",
  identity: "orchid",
  sync: "teal",
};

/** The mark each section uses: the Pinned K for the platform, the Star Cut for delivery. */
export const SERVICE_MARK: Record<ServiceId, "key" | "update"> = {
  core: "key",
  license: "key",
  config: "key",
  release: "key",
  distribution: "update",
  update: "update",
  identity: "key",
  sync: "key",
};

/** Human labels (tools/services.json `label`; Core is the platform). */
export const SERVICE_LABEL: Record<ServiceId, string> = {
  core: "Core",
  license: "License",
  config: "Config",
  release: "Release",
  distribution: "Distribution",
  update: "Update",
  identity: "Identity",
  sync: "Cloud Sync",
};

/**
 * One accent family in one theme.
 *   solid   the family's identity colour: indicators, nav markers, fills, icons, the section
 *           bit. >= 3:1 on every surface of the theme.
 *   fg      text and links in the family's colour. >= 4.5:1 on every surface.
 *   on      text set on a `solid` fill. >= 4.5:1 against `solid`.
 *   subtle  a tinted surface (selected row, active nav item): `solid` at `subtleAlpha` over the
 *           page ground, flattened to an opaque hex (no transparency, no gradient).
 */
export interface AccentSpec {
  solid: ColorSpec;
  fg: ColorSpec;
  on: ColorSpec;
}

export const SUBTLE_ALPHA: Record<Theme, number> = { dark: 0.12, light: 0.1 };

/**
 * The hover tint is a lighter step than the selected fill (B17): the family's `solid` at this
 * alpha over the page ground, flattened. It carries the same text pair as the selected fill.
 */
export const HOVER_ALPHA: Record<Theme, number> = { dark: 0.07, light: 0.06 };

/**
 * The action-neutral role (B2): the primary action in the console, portal and hosted sign-in is
 * neutral ink, not an accent. `fill` is the button; `on` is its label. Kits keep the host or
 * product accent as their primary (DL13), so this role is not a kit colour. Danger stays red.
 */
export interface ActionSpec {
  fill: ColorSpec;
  on: ColorSpec;
}

export const ACTION: Record<Theme, ActionSpec> = {
  dark: { fill: BRAND.page.light, on: BRAND.page.dark },
  light: { fill: BRAND.page.dark, on: BRAND.mono.white },
};

export const ACCENTS: Record<AccentFamily, Record<Theme, AccentSpec>> = {
  // The platform accent is the kit violet itself in both themes.
  violet: {
    dark: {
      solid: BRAND.violet.dark,
      fg: BRAND.violet.dark,
      on: BRAND.mono.black,
    },
    light: {
      solid: BRAND.violet.light,
      fg: BRAND.violet.light,
      on: BRAND.mono.white,
    },
  },
  // License. Was amber, which is the gold signing bit's territory; chartreuse is the nearest
  // hue that stays a clear ΔE from both golds.
  chartreuse: {
    dark: {
      solid: oklch(0.88, 0.19, 121),
      fg: oklch(0.88, 0.19, 121),
      on: BRAND.mono.black,
    },
    light: {
      // Darkened from L 0.60 (#708d00) to L 0.58 so a checked control and a bar clear 3.4:1 on
      // every surface (B17). The proposed #678200 is darker but lands 17.4 from the Distribution
      // green; the 17.5 floor is not lowered, so chroma rises to 0.15 instead (ΔE00 18.7).
      solid: oklch(0.58, 0.15, 122),
      fg: oklch(0.5, 0.125, 124),
      on: BRAND.mono.black,
    },
  },
  // Config (owner decision 2026-10-03): yellow, from the owner's #ffd43b / #8a6a00, tuned by
  // scripts/tune-accents.ts (hue held at 90-100° so it stays yellow, not amber or lime) to the
  // value farthest (CIEDE2000) from the License chartreuse and every other accent.
  yellow: {
    dark: {
      solid: oklch(0.85, 0.175, 90),
      fg: oklch(0.85, 0.175, 90),
      on: BRAND.mono.black,
    },
    light: {
      solid: oklch(0.54, 0.11, 86),
      fg: oklch(0.525, 0.11, 86),
      on: BRAND.mono.white,
    },
  },
  // Release. Was violet (the platform's alone), then teal; with Config yellow it is the only
  // blue-green, and scripts/tune-accents.ts's optimum over the whole teal-to-cyan arc (150-214°,
  // up to the blue band) is this cyan, farthest from the Distribution green.
  cyan: {
    dark: {
      solid: oklch(0.82, 0.145, 214),
      fg: oklch(0.82, 0.145, 214),
      on: BRAND.mono.black,
    },
    light: {
      // Darkened from L 0.60 (#0390a6) to L 0.59, which clears 3.4:1 on every surface and keeps
      // ΔE00 18.2 from the nearest accent (the proposed #03879c sits 16.3 from Cloud Sync teal,
      // under the 17.5 floor, so it is not used) (B17).
      solid: oklch(0.59, 0.105, 214),
      fg: oklch(0.515, 0.105, 214),
      on: BRAND.mono.black,
    },
  },
  // Distribution (a Star Cut service). Update shared it until 2026-10-03.
  green: {
    dark: {
      solid: oklch(0.76, 0.18, 152),
      fg: oklch(0.76, 0.18, 152),
      on: BRAND.mono.black,
    },
    light: {
      solid: oklch(0.5, 0.13, 152),
      fg: oklch(0.5, 0.13, 152),
      on: BRAND.mono.white,
    },
  },
  // Update (owner decisions 2026-10-03): tangerine. Dark is the owner's #fe8001; light is a
  // bright orange within ±6° and ±0.03 lightness of the owner's #b04a00, tuned by
  // scripts/tune-accents.ts to the value farthest (CIEDE2000) from danger and the other accents.
  tangerine: {
    dark: {
      solid: oklch(0.73, 0.185, 53),
      fg: oklch(0.73, 0.185, 53),
      on: BRAND.mono.black,
    },
    light: {
      solid: oklch(0.57, 0.15, 51),
      fg: oklch(0.535, 0.15, 51),
      on: BRAND.mono.white,
    },
  },
  // Identity. Was rose, which the kit reserves; orchid is held between the platform violet and
  // the reserved rose at a ΔE >= 0.12 from each (and outside the rose hue band).
  orchid: {
    dark: {
      solid: oklch(0.73, 0.185, 318),
      fg: oklch(0.73, 0.185, 318),
      on: BRAND.mono.black,
    },
    light: {
      solid: oklch(0.53, 0.2, 322),
      fg: oklch(0.53, 0.2, 322),
      on: BRAND.mono.white,
    },
  },
  // Cloud Sync (U-04, 2026-10-05). scripts/tune-accents.ts's `search` over the three gaps the
  // palette leaves (teal 160-214°, red-orange 26-50°, magenta 286-334°; dark lightness 0.73-0.88,
  // chroma >= 0.12; light 0.45-0.60, chroma >= 0.075) lands on this teal in both themes, the
  // farthest (CIEDE2000) from every other accent, rose and danger: 19.0 dark and 19.3 light, both
  // nearest the Release cyan. Red-orange (17.3 / 17.2, by Update and danger) and magenta (15.0 /
  // 18.6, by Identity) measure closer. Light chroma 0.085 (17.46 from the cyan) misses the 17.5
  // floor and the 0.085 ΔEOK floor against the Distribution green, so light steps down to 0.075.
  teal: {
    dark: {
      solid: oklch(0.88, 0.155, 183),
      fg: oklch(0.88, 0.155, 183),
      on: BRAND.mono.black,
    },
    light: {
      solid: oklch(0.45, 0.075, 192),
      fg: oklch(0.45, 0.075, 192),
      on: BRAND.mono.white,
    },
  },
};

// ── Neutrals ────────────────────────────────────────────────────────────────────────────────

export interface NeutralSpec {
  surface: {
    page: ColorSpec;
    raised: ColorSpec;
    overlay: ColorSpec;
    sunken: ColorSpec;
  };
  text: {
    strong: ColorSpec;
    default: ColorSpec;
    muted: ColorSpec;
    subtle: ColorSpec;
    onAccent: ColorSpec;
  };
  border: { subtle: ColorSpec; strong: ColorSpec };
  focus: ColorSpec;
}

export const NEUTRALS: Record<Theme, NeutralSpec> = {
  dark: {
    surface: {
      page: BRAND.page.dark,
      raised: oklch(0.18, 0.022, NEUTRAL_HUE),
      overlay: oklch(0.205, 0.024, NEUTRAL_HUE),
      sunken: oklch(0.105, 0.016, NEUTRAL_HUE),
    },
    text: {
      strong: BRAND.text.dark,
      default: BRAND.muted.dark,
      muted: oklch(0.8, 0.032, NEUTRAL_HUE),
      subtle: oklch(0.7, 0.03, NEUTRAL_HUE),
      onAccent: BRAND.mono.black,
    },
    border: {
      subtle: oklch(0.27, 0.025, NEUTRAL_HUE),
      strong: oklch(0.52, 0.03, NEUTRAL_HUE),
    },
    focus: BRAND.violet.dark,
  },
  light: {
    surface: {
      page: BRAND.page.light,
      raised: "#ffffff",
      overlay: "#ffffff",
      sunken: oklch(0.95, 0.013, NEUTRAL_HUE + 4),
    },
    text: {
      strong: BRAND.text.light,
      default: oklch(0.3, 0.035, NEUTRAL_HUE),
      muted: BRAND.muted.light,
      subtle: oklch(0.51, 0.035, NEUTRAL_HUE),
      onAccent: BRAND.mono.white,
    },
    border: {
      subtle: oklch(0.9, 0.016, NEUTRAL_HUE + 2),
      strong: oklch(0.62, 0.03, NEUTRAL_HUE),
    },
    focus: BRAND.violet.light,
  },
};

// ── Status and the signed indicator ─────────────────────────────────────────────────────────

/**
 * A status colour in one theme.
 *   fg      text and icons. >= 4.5:1 on every surface and on `subtle`.
 *   on      text on an `fg` fill (a solid badge). >= 4.5:1.
 *   border  the outline of a status callout. >= 3:1 on the page ground and on `subtle`.
 *   subtle  the callout background: `fg` at SUBTLE_ALPHA over the page, flattened.
 */
export interface StatusSpec {
  fg: ColorSpec;
  on: ColorSpec;
  border: ColorSpec;
}

export const STATUS_IDS = ["success", "warning", "danger", "info"] as const;
export type StatusId = (typeof STATUS_IDS)[number];

export const STATUS: Record<StatusId, Record<Theme, StatusSpec>> = {
  success: {
    dark: {
      fg: oklch(0.78, 0.17, 150),
      on: BRAND.mono.black,
      border: oklch(0.6, 0.13, 150),
    },
    light: {
      fg: oklch(0.49, 0.125, 150),
      on: BRAND.mono.white,
      border: oklch(0.58, 0.13, 150),
    },
  },
  // Amber (owner decision 2026-10-03), moved out of the orange so it cannot be taken for the
  // Update tangerine or the Config yellow: scripts/tune-accents.ts picks the value between the two
  // farthest (CIEDE2000) from both and from danger, still ΔEOK >= 0.12 from the signed indicator.
  // Dark is a deeper amber than the kit gold; light, where 4.5:1 text leaves only dark ambers, is
  // a brown amber.
  warning: {
    dark: {
      fg: oklch(0.68, 0.135, 80),
      on: BRAND.mono.black,
      border: oklch(0.52, 0.135, 80),
    },
    light: {
      fg: oklch(0.47, 0.105, 67),
      on: BRAND.mono.white,
      // The tuner's lightest 3:1 outline (L 0.62) sits next to the signed border; 0.56 keeps a
      // clear step from it (and still clears 3:1 on the page and the callout).
      border: oklch(0.56, 0.105, 67),
    },
  },
  // Red, held a clear ΔE from the reserved rose (darker and more orange than #ff6fa6).
  danger: {
    dark: {
      fg: oklch(0.655, 0.2, 30),
      on: BRAND.mono.black,
      border: oklch(0.56, 0.18, 30),
    },
    light: {
      fg: oklch(0.52, 0.19, 27),
      on: BRAND.mono.white,
      border: oklch(0.6, 0.19, 27),
    },
  },
  // Info is violet, never blue. Lifted in dark so it clears 4.5:1 on its own tinted callout, and
  // turned a few degrees toward purple so its HSL hue stays clear of the blue band.
  info: {
    dark: {
      fg: oklch(0.72, 0.17, 300),
      on: BRAND.mono.black,
      border: oklch(0.58, 0.2, 300),
    },
    light: {
      fg: BRAND.violet.light,
      on: BRAND.mono.white,
      border: oklch(0.62, 0.2, 293),
    },
  },
};

/**
 * The signed indicator: gold in UI means a signing key, a signed record or a verified signature,
 * and nothing else ("gold is the signing bit"). It is an indicator colour (glyph, chip fill, the
 * K's bit), never a text colour: label a signed thing with `text-*` beside the gold glyph, or
 * with `on` inside a gold chip.
 *   mark    the K's terminal bit: the kit gold, exact. Artwork only.
 *   solid   the UI indicator. Dark: the kit gold. Light: the kit gold deepened just enough to
 *           clear 3:1 on the sunken surface (the kit's #d07a00 is 2.8:1 there).
 *   on      text on a `solid` chip.
 *   border  the chip / callout outline.
 */
export interface SignedSpec {
  mark: ColorSpec;
  solid: ColorSpec;
  on: ColorSpec;
  border: ColorSpec;
}

export const SIGNED: Record<Theme, SignedSpec> = {
  dark: {
    mark: BRAND.gold.dark,
    solid: BRAND.gold.dark,
    on: BRAND.mono.black,
    border: oklch(0.66, 0.12, 78),
  },
  light: {
    mark: BRAND.gold.light,
    solid: oklch(0.63, 0.145, 63.5),
    on: BRAND.mono.black,
    border: oklch(0.62, 0.14, 64),
  },
};
