// The colour rules, as data and as a checker. test/accents.test.ts applies them to every accent
// and status colour; a consumer adding a product colour can run `colorViolations` on it.
//
// Hue arcs are clockwise [from, to) in degrees.
//   * blue / indigo: forbidden in brand artwork (kit README: "No gradients, indigo or parent-brand
//     blue"). Checked twice, in OKLCH hue and in HSL hue, so neither model's quirks let a blue
//     through. The kit violet sits just outside both (OKLCH 290–297°, HSL 262–263°).
//   * rose / pink: reserved for display treatments (kit README), so no UI accent may use it.
//   * gold: the signing bit. Since 2026-10-03 the core K carries no gold bit, so the gold distance
//     applies to the kit's signed artwork, the kit lockups and the UI signed indicator only, not to
//     section accents (pass `{ gold: false }` for an accent). Status colours keep it.

import {
  contrastRatio,
  deltaEOK,
  hexToOklch,
  hslHue,
  hueInArc,
} from "../color.js";
import { BRAND } from "./primitives.js";
import type { Theme } from "./source.js";

export const COLOR_RULES = {
  blueIndigo: { oklch: [215, 285] as const, hsl: [190, 260] as const },
  rose: { oklch: [335, 25] as const },
  /**
   * Minimum OKLab distance between any two section accents (same theme). 0.12 until 2026-10-03;
   * 0.085 since Config became yellow (measured minimum 0.090, light Config vs Update; 0.102 dark
   * Config vs License). CIEDE2000 floors in test/accents.test.ts govern distinctness; this is the
   * second metric.
   */
  accentMinDeltaE: 0.085,
  /** Minimum OKLab distance from the kit gold (and the UI signed colour) for anything not gold. */
  goldMinDeltaE: 0.12,
  /** Minimum OKLab distance from the reserved rose. */
  roseMinDeltaE: 0.12,
  /** Text on its ground. */
  textContrast: 4.5,
  /** UI components and focus indicators. */
  uiContrast: 3,
} as const;

export interface Violation {
  rule: string;
  detail: string;
}

/**
 * Every brand colour rule `hex` breaks as an accent or status colour in `theme`. The kit violet
 * is the platform's own and is exempt from nothing: it passes all of these.
 */
export function colorViolations(
  hex: string,
  theme: Theme,
  opts: { signedSolid?: string; gold?: boolean } = {},
): Violation[] {
  const v: Violation[] = [];
  const { h } = hexToOklch(hex);
  const hsl = hslHue(hex);
  const [bf, bt] = COLOR_RULES.blueIndigo.oklch;
  const [hf, ht] = COLOR_RULES.blueIndigo.hsl;
  if (hueInArc(h, bf, bt))
    v.push({ rule: "blue-indigo", detail: `OKLCH hue ${h.toFixed(1)}°` });
  if (hueInArc(hsl, hf, ht))
    v.push({ rule: "blue-indigo", detail: `HSL hue ${hsl.toFixed(1)}°` });
  const [rf, rt] = COLOR_RULES.rose.oklch;
  if (hueInArc(h, rf, rt))
    v.push({ rule: "rose", detail: `OKLCH hue ${h.toFixed(1)}°` });
  const dRose = deltaEOK(hex, BRAND.rose[theme]);
  if (dRose < COLOR_RULES.roseMinDeltaE)
    v.push({
      rule: "rose",
      detail: `ΔE ${dRose.toFixed(3)} from ${BRAND.rose[theme]}`,
    });
  if (opts.gold === false) return v;
  for (const gold of [BRAND.gold[theme], opts.signedSolid].filter(
    Boolean,
  ) as string[]) {
    const d = deltaEOK(hex, gold);
    if (d < COLOR_RULES.goldMinDeltaE)
      v.push({ rule: "gold", detail: `ΔE ${d.toFixed(3)} from ${gold}` });
  }
  return v;
}

/** WCAG contrast check helper used by docs and tests. */
export function meets(fg: string, bg: string, min: number): boolean {
  return contrastRatio(fg, bg) >= min;
}
