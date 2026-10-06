// The accent resolver (docs/design/UI-KITS.md §3.3): one algorithm, ported to Swift, Kotlin,
// GDScript and Python with the shared vectors in fixtures/accent-vectors.json, so every kit gives
// the same answer for the same product.
//
//   deriveAccent(rgba)          the input colour when a product supplies none: the most saturated
//                               hue cluster of the icon's opaque pixels, at an accent lightness
//   resolveAccent(hex, scheme)  solid, on, fg, subtle and focus for one colour scheme
//
// Every step is a lightness move in OKLCH (hue and chroma held; chroma is only trimmed when a
// lightness leaves the sRGB gamut, by oklchToHex). The searches are fixed-length bisections and
// every comparison is a WCAG 2 contrast on the rounded hex, so a port that follows this file
// step for step lands on the same hex. Change the algorithm only together with every port and
// the vectors.

import {
  contrastRatio,
  hexToOklch,
  mixOver,
  normalizeHex,
  oklchToHex,
  rgbToOklab,
  oklabToOklch,
  type Oklch,
} from "./color.js";
import { BRAND } from "./tokens/primitives.js";
import { resolveTokens } from "./tokens/resolve.js";
import { SUBTLE_ALPHA, type Theme } from "./tokens/source.js";

/** White, the preferred label on a solid fill. */
export const ACCENT_WHITE = "#ffffff";
/** Ink, the label a light accent takes instead (the kit's page ground). */
export const ACCENT_INK = BRAND.mono.black;

/** The resolver's constants. Every port carries the same numbers. */
export const ACCENT_RULES = {
  /** Text contrast: `fg` on every surface, `on` on `solid`. */
  text: 4.5,
  /** UI contrast: `solid` on every surface. */
  ui: 3,
  /** How far `solid` may darken (OKLCH lightness) to keep a white label. */
  whiteShift: 0.08,
  /** `fg` starts at least this light in dark schemes… */
  fgDarkL: 0.78,
  /** …and at most this light in light schemes, then moves until it clears `text`. */
  fgLightL: 0.52,
  /** Bisection steps for every lightness search. */
  steps: 32,
  /** deriveAccent: alpha (0..255) at or above which a pixel counts as opaque. */
  opaqueAlpha: 128,
  /** deriveAccent: OKLCH chroma below which a pixel is grey and joins no cluster. */
  greyChroma: 0.04,
  /** deriveAccent: hue clusters are this many degrees wide, starting at 0°. */
  hueBin: 30,
  /** deriveAccent: a cluster must cover at least this share of the opaque pixels. */
  minShare: 0.08,
  /** deriveAccent: the derived colour's lightness is clamped into this band. */
  derivedL: [0.45, 0.6] as const,
} as const;

export type AccentLabel = "white" | "ink";

export interface ResolvedProductAccent {
  /** Fills and indicators: >= 3:1 on every surface of the scheme. */
  solid: string;
  /** The label on `solid`: white unless the accent is light; the same in both schemes. */
  on: string;
  /** Text and links: >= 4.5:1 on every surface of the scheme. */
  fg: string;
  /** The tinted fill for selected rows: `solid` over the page, flattened. */
  subtle: string;
  /** The focus ring: `fg` in dark schemes, `solid` in light ones (>= 3:1 either way). */
  focus: string;
}

const TOKENS = resolveTokens();

/** The four surfaces of a scheme, in the order every port lists them. */
export function accentSurfaces(scheme: Theme): readonly string[] {
  const s = TOKENS[scheme].surface;
  return [s.page, s.raised, s.overlay, s.sunken];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

const at = (base: Oklch, l: number) =>
  oklchToHex({ l: clamp01(l), c: base.c, h: base.h });

/**
 * The smallest lightness move from `base` in `dir` (-1 darker, +1 lighter) whose hex satisfies
 * `ok`: `base` itself when it already does, the extreme (black or white end) when nothing does.
 */
function moveUntil(
  base: Oklch,
  dir: -1 | 1,
  ok: (hex: string) => boolean,
): string {
  const start = at(base, base.l);
  if (ok(start)) return start;
  let lo = 0;
  let hi = dir < 0 ? base.l : 1 - base.l;
  if (!ok(at(base, base.l + dir * hi))) return at(base, base.l + dir * hi);
  for (let i = 0; i < ACCENT_RULES.steps; i++) {
    const mid = (lo + hi) / 2;
    if (ok(at(base, base.l + dir * mid))) hi = mid;
    else lo = mid;
  }
  return at(base, base.l + dir * hi);
}

const clears = (hex: string, grounds: readonly string[], min: number) =>
  grounds.every((g) => contrastRatio(hex, g) >= min);

/**
 * The label a colour takes on its solid fill. White when darkening it by at most
 * `whiteShift` reaches 4.5:1 against white; ink otherwise. It depends on the colour alone, never
 * the scheme, so a product's primary button reads the same in dark and light.
 */
export function accentLabel(hex: string): AccentLabel {
  const base = hexToOklch(normalizeHex(hex));
  const shifted = at(base, base.l - ACCENT_RULES.whiteShift);
  return contrastRatio(ACCENT_WHITE, shifted) >= ACCENT_RULES.text
    ? "white"
    : "ink";
}

/** `solid` for a colour, a label and a scheme. Shared by resolveAccent and the danger solid. */
export function accentSolid(
  hex: string,
  scheme: Theme,
  label: AccentLabel,
): string {
  const base = hexToOklch(normalizeHex(hex));
  const surfaces = accentSurfaces(scheme);
  const onUi = (h: string) => clears(h, surfaces, ACCENT_RULES.ui);
  if (label === "white") {
    const readable = (h: string) =>
      contrastRatio(ACCENT_WHITE, h) >= ACCENT_RULES.text;
    const solid = moveUntil(base, -1, readable);
    // A dark scheme's surfaces are dark: a very dark colour lifts until it clears 3:1 on them.
    return scheme === "dark" && !onUi(solid)
      ? moveUntil(hexToOklch(solid), 1, onUi)
      : solid;
  }
  const readable = (h: string) =>
    contrastRatio(ACCENT_INK, h) >= ACCENT_RULES.text;
  const solid = moveUntil(base, 1, readable);
  // A light scheme's surfaces are light: a light colour deepens until it clears 3:1 on them.
  return scheme === "light" && !onUi(solid)
    ? moveUntil(hexToOklch(solid), -1, onUi)
    : solid;
}

/** `fg` for a colour in a scheme: text that clears 4.5:1 on every surface. */
export function accentFg(hex: string, scheme: Theme): string {
  const base = hexToOklch(normalizeHex(hex));
  const surfaces = accentSurfaces(scheme);
  const readable = (h: string) => clears(h, surfaces, ACCENT_RULES.text);
  return scheme === "dark"
    ? moveUntil(
        { ...base, l: Math.max(base.l, ACCENT_RULES.fgDarkL) },
        1,
        readable,
      )
    : moveUntil(
        { ...base, l: Math.min(base.l, ACCENT_RULES.fgLightL) },
        -1,
        readable,
      );
}

/** Resolve any input colour into the five accent roles for one scheme (UI-KITS.md §3.3). */
export function resolveAccent(
  hex: string,
  scheme: Theme,
): ResolvedProductAccent {
  const label = accentLabel(hex);
  const solid = accentSolid(hex, scheme, label);
  const fg = accentFg(hex, scheme);
  return {
    solid,
    on: label === "white" ? ACCENT_WHITE : ACCENT_INK,
    fg,
    subtle: mixOver(solid, SUBTLE_ALPHA[scheme], accentSurfaces(scheme)[0]!),
    focus: scheme === "dark" ? fg : solid,
  };
}

/**
 * The input colour for a product that supplies none, from its icon: `rgba` is the icon's pixels
 * as RGBA bytes (row-major, 4 per pixel; `ImageData.data` in a browser).
 *
 * Opaque pixels (alpha >= 128) that are not grey (OKLCH chroma >= 0.04) fall into 30° hue
 * clusters. Of the clusters that cover at least 8 % of the opaque pixels, the one with the highest
 * mean chroma wins (a tie goes to the larger cluster, then the lower hue). Its mean OKLab colour,
 * with lightness clamped to 0.45–0.60 (an icon colour is art, the accent is UI), is the answer.
 * `null` for an icon with no such cluster (near-greyscale or empty): the kit falls back to ink.
 */
export function deriveAccent(rgba: ArrayLike<number>): string | null {
  const bins = ACCENT_RULES.hueBin;
  const count = Math.floor(360 / bins);
  const n: number[] = new Array(count).fill(0);
  const sumL: number[] = new Array(count).fill(0);
  const sumA: number[] = new Array(count).fill(0);
  const sumB: number[] = new Array(count).fill(0);
  const sumC: number[] = new Array(count).fill(0);
  let opaque = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < ACCENT_RULES.opaqueAlpha) continue;
    opaque++;
    const lab = rgbToOklab({
      r: rgba[i]! / 255,
      g: rgba[i + 1]! / 255,
      b: rgba[i + 2]! / 255,
    });
    const lch = oklabToOklch(lab);
    if (lch.c < ACCENT_RULES.greyChroma) continue;
    const k = Math.min(count - 1, Math.floor(lch.h / bins));
    n[k]!++;
    sumL[k]! += lab.l;
    sumA[k]! += lab.a;
    sumB[k]! += lab.b;
    sumC[k]! += lch.c;
  }
  if (opaque === 0) return null;
  let best = -1;
  for (let k = 0; k < count; k++) {
    if (n[k]! < ACCENT_RULES.minShare * opaque) continue;
    if (best < 0) {
      best = k;
      continue;
    }
    const chroma = sumC[k]! / n[k]!;
    const bestChroma = sumC[best]! / n[best]!;
    if (chroma > bestChroma || (chroma === bestChroma && n[k]! > n[best]!))
      best = k;
  }
  if (best < 0) return null;
  const mean = oklabToOklch({
    l: sumL[best]! / n[best]!,
    a: sumA[best]! / n[best]!,
    b: sumB[best]! / n[best]!,
  });
  const [lo, hi] = ACCENT_RULES.derivedL;
  return oklchToHex({ ...mean, l: Math.min(hi, Math.max(lo, mean.l)) });
}
