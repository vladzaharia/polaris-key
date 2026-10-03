// Accent tuning by measurement (owner decisions 2026-10-03: Update becomes tangerine; Release
// moves off teal because it read too close to Config's cyan).
//
//   pnpm --filter @polaris-key/brand exec tsx scripts/tune-accents.ts
//
// A reproducible grid search in OKLCH. For one section at a time it keeps only candidates that
// satisfy every rule the palette is tested against (test/contrast.test.ts, test/accents.test.ts):
//
//   * `solid` >= 3:1 on every surface and on its own `subtle`; `fg` >= 4.5:1 on every surface and
//     on `subtle`; body and strong text >= 4.5:1 on `subtle`; `on` >= 4.5:1 on `solid`;
//   * not blue/indigo, not rose, ΔEOK >= 0.12 from the kit gold and the UI signed colour
//     (`colorViolations`), and ΔEOK >= 0.12 from every other family;
//   * in sRGB gamut, inside the palette's lightness band for the theme (the range the existing
//     accents span), and at least as vivid as the least vivid existing accent of the theme. Without
//     these two limits a pure max-min search wins by going muddy: dull olive and dark brown sit far
//     from every vivid colour but read as nobody's accent (the first unconstrained run picked
//     #848616 and #4c4b02 for Release);
//
// and among those picks the one that maximises the minimum CIEDE2000 distance to the reference set:
// every other section accent, the platform violet, the kit gold, the UI signed colour, the kit
// rose and the danger tokens. In dark, `fg` = `solid`; in light, `fg` is the same hue and chroma
// stepped down in lightness until it reads as text (the existing light accents do the same).
//
// Run order: Update first, held to a tangerine hue window around the owner's starting point
// (#ff8a3d / #b04a00), then Release against everything including the new Update. The chosen
// values are copied into src/tokens/source.ts; test/accents.test.ts re-measures them.

import {
  contrastRatio,
  deltaE2000,
  deltaEOK,
  hexToOklch,
  mixOver,
  oklchToHex,
} from "../src/color.js";
import { THEME_TOKENS } from "../src/generated/tokens.js";
import { BRAND } from "../src/tokens/primitives.js";
import { colorViolations } from "../src/tokens/rules.js";
import { SUBTLE_ALPHA, type Theme } from "../src/tokens/source.js";

export interface Candidate {
  oklch: [number, number, number];
  solid: string;
  fg: string;
  fgL: number;
  on: string;
  minDE00: number;
  nearest: string;
}

/** Every rule a section accent must pass, for one theme. Returns the full accent or null. */
export function admissible(
  theme: Theme,
  l: number,
  c: number,
  h: number,
  others: Record<string, string>,
): Omit<Candidate, "minDE00" | "nearest"> | null {
  const t = THEME_TOKENS[theme];
  const solid = oklchToHex({ l, c, h });
  // Out of gamut: oklchToHex sheds chroma, so the hex is no longer this candidate.
  if (Math.abs(hexToOklch(solid).c - c) > 0.003) return null;
  const surfaces = Object.values(t.surface);
  if (surfaces.some((s) => contrastRatio(solid, s) < 3)) return null;
  const subtle = mixOver(solid, SUBTLE_ALPHA[theme], t.surface.page);
  if (contrastRatio(solid, subtle) < 3) return null;
  if (contrastRatio(t.text.default, subtle) < 4.5) return null;
  if (contrastRatio(t.text.strong, subtle) < 4.5) return null;
  const textOk = (hex: string) =>
    surfaces.every((s) => contrastRatio(hex, s) >= 4.5) &&
    contrastRatio(hex, subtle) >= 4.5;
  let fg = solid;
  let fgL = l;
  if (!textOk(fg)) {
    if (theme === "dark") return null;
    for (fgL = l - 0.005; fgL > 0.3; fgL -= 0.005) {
      fg = oklchToHex({ l: fgL, c, h });
      if (textOk(fg)) break;
    }
    if (!textOk(fg)) return null;
  }
  const on = [BRAND.mono.black, BRAND.mono.white].sort(
    (a, b) => contrastRatio(b, solid) - contrastRatio(a, solid),
  )[0]!;
  if (contrastRatio(on, solid) < 4.5) return null;
  const signedSolid = t.signed.solid;
  if (colorViolations(solid, theme, { signedSolid }).length) return null;
  if (colorViolations(fg, theme, { signedSolid }).length) return null;
  for (const o of Object.values(others))
    if (deltaEOK(solid, o) < 0.12) return null;
  return {
    oklch: [l, c, h],
    solid,
    fg,
    fgL: Math.round(fgL * 1000) / 1000,
    on,
  };
}

/** The reference set a section is kept away from, besides the other section accents. */
export function references(theme: Theme): Record<string, string> {
  const t = THEME_TOKENS[theme];
  return {
    "kit gold": BRAND.gold[theme],
    signed: t.signed.solid,
    rose: BRAND.rose[theme],
    "danger fg": t.status.danger.fg,
    "danger border": t.status.danger.border,
  };
}

export function minDistance(
  hex: string,
  set: Record<string, string>,
): { min: number; nearest: string } {
  let min = Infinity;
  let nearest = "";
  for (const [k, v] of Object.entries(set)) {
    const d = deltaE2000(hex, v);
    if (d < min) [min, nearest] = [d, k];
  }
  return { min, nearest };
}

/** The best admissible accent in a hue window. */
export function search(
  theme: Theme,
  others: Record<string, string>,
  hues: readonly [number, number],
  lightness: readonly [number, number],
  minChroma: number,
): Candidate | null {
  const set = { ...others, ...references(theme) };
  let best: Candidate | null = null;
  for (let h = hues[0]; h <= hues[1]; h += 1)
    for (let l = lightness[0]; l <= lightness[1] + 1e-9; l += 0.01)
      for (let c = minChroma; c <= 0.26; c += 0.005) {
        const r3 = (n: number) => Math.round(n * 1000) / 1000;
        const a = admissible(theme, r3(l), r3(c), h % 360, others);
        if (!a) continue;
        const { min, nearest } = minDistance(a.solid, set);
        // Ties (to 0.05 ΔE00) go to the more vivid candidate.
        if (
          !best ||
          min > best.minDE00 + 0.05 ||
          (Math.abs(min - best.minDE00) <= 0.05 && c > best.oklch[1])
        )
          best = { ...a, minDE00: min, nearest };
      }
  return best;
}

const isMain = process.argv[1]?.endsWith("tune-accents.ts");
if (isMain) {
  const fixed = (theme: Theme) => {
    const a = THEME_TOKENS[theme].accent;
    return {
      violet: a.violet.solid,
      chartreuse: a.chartreuse.solid,
      cyan: a.cyan.solid,
      green: a.green.solid,
      orchid: a.orchid.solid,
    };
  };
  // The least vivid existing accent per theme (Config's cyan in both).
  const minChroma = (theme: Theme) =>
    Math.min(
      ...Object.values(fixed(theme))
        .filter((h) => h !== BRAND.violet[theme])
        .map((h) => Math.floor(hexToOklch(h).c * 200) / 200),
    );
  // The lightness band the existing service accents span (OKLCH L of their solids).
  const band = (theme: Theme): [number, number] => {
    const ls = Object.values(fixed(theme))
      .filter((h) => h !== BRAND.violet[theme])
      .map((h) => hexToOklch(h).l);
    return [
      Math.floor(Math.min(...ls) * 100) / 100,
      Math.ceil(Math.max(...ls) * 100) / 100,
    ];
  };
  for (const theme of ["dark", "light"] as const) {
    const others = fixed(theme);
    console.log(
      `\n${theme}: lightness band ${band(theme)}, chroma floor ${minChroma(theme)}`,
    );
    const start = theme === "dark" ? "#ff8a3d" : "#b04a00";
    console.log(
      `\n${theme}: owner's tangerine ${start} = OKLCH ${JSON.stringify(hexToOklch(start))}`,
    );
    // Tangerine: within ±10° of the owner's starting hue, ±0.05 of its lightness and at least 90%
    // of its chroma, so it stays recognisably the owner's tangerine.
    const s0 = hexToOklch(start);
    const h0 = Math.round(s0.h);
    const l0 = Math.round(s0.l * 100) / 100;
    const tangerine = search(
      theme,
      others,
      [h0 - 10, h0 + 10],
      [l0 - 0.05, l0 + 0.05],
      Math.floor(s0.c * 0.9 * 200) / 200,
    );
    console.log("  update (tangerine):", JSON.stringify(tangerine));
    if (!tangerine) continue;
    const withUpdate = { ...others, tangerine: tangerine.solid };
    // Release: the whole wheel outside the blue/indigo and rose arcs (colorViolations enforces them).
    const release = search(
      theme,
      withUpdate,
      [25, 335],
      band(theme),
      minChroma(theme),
    );
    console.log("  release:", JSON.stringify(release));
  }
}
