// Accent tuning by measurement (owner decisions 2026-10-03). Run 1 made Update tangerine and
// re-tuned Release; run 2 (this file's main block) follows the owner's review of the proofs:
// Config yellow, Update light a bright orange, Release free over the teal-to-cyan arc, and the
// warning status moved to the amber between Update and Config.
//
//   pnpm --filter @polaris-key/brand exec tsx scripts/tune-accents.ts
//
// A reproducible grid search in OKLCH. For one colour at a time it keeps only candidates that
// satisfy every rule the palette is tested against (test/contrast.test.ts, test/accents.test.ts):
//
//   * accents: `solid` >= 3:1 on every surface and on its own `subtle`; `fg` >= 4.5:1 on every
//     surface and on `subtle`; body and strong text >= 4.5:1 on `subtle`; `on` >= 4.5:1 on
//     `solid`; statuses: `fg` >= 4.5:1 everywhere, `on` >= 4.5:1, `border` >= 3:1;
//   * not blue/indigo, not rose (`colorViolations`); section accents are exempt from the gold
//     distance since the core K lost its gold bit;
//   * in sRGB gamut, inside a lightness band and above a chroma floor. Without these limits a
//     pure max-min search wins by going muddy: dull olive and dark brown sit far from every vivid
//     colour but read as nobody's accent (unconstrained runs picked #848616 and #4c4b02 for
//     Release, #9c7b31 and #71330c for warning);
//
// and among those picks the one that maximises the minimum CIEDE2000 distance to the reference set
// (the other accents, the platform violet, the kit rose and the danger tokens; for warning, Config,
// Update and danger). In dark, `fg` = `solid`; in light, `fg` is the same hue and chroma stepped
// down in lightness until it reads as text. The chosen values are copied into
// src/tokens/source.ts; test/accents.test.ts re-measures them against floors derived from them.

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
  // Section accents are exempt from the gold distance since 2026-10-03 (the core K has no gold
  // bit); the blue/indigo and rose rules still apply.
  if (colorViolations(solid, theme, { gold: false }).length) return null;
  if (colorViolations(fg, theme, { gold: false }).length) return null;
  // Pairwise distinctness is the CIEDE2000 objective (and the floors in test/accents.test.ts);
  // the older ΔEOK >= 0.12 gate is dropped because it rejects the owner's own yellow (#ffd43b is
  // ΔEOK 0.091 from the License chartreuse, yet ΔE00 17.8).
  void others;
  return {
    oklch: [l, c, h],
    solid,
    fg,
    fgL: Math.round(fgL * 1000) / 1000,
    on,
  };
}

/**
 * The reference set a section is kept away from, besides the other section accents: the kit rose
 * and the danger tokens. (The kit gold and the UI signed colour left this set on 2026-10-03.)
 */
export function references(theme: Theme): Record<string, string> {
  const t = THEME_TOKENS[theme];
  return {
    rose: BRAND.rose[theme],
    "danger fg": t.status.danger.fg,
    "danger border": t.status.danger.border,
  };
}

/** A status colour (fg, on, border) that passes every status rule in test/contrast.test.ts. */
export function admissibleStatus(
  theme: Theme,
  l: number,
  c: number,
  h: number,
): {
  oklch: [number, number, number];
  fg: string;
  on: string;
  border: string;
} | null {
  const t = THEME_TOKENS[theme];
  const fg = oklchToHex({ l, c, h });
  if (Math.abs(hexToOklch(fg).c - c) > 0.003) return null;
  const surfaces = Object.values(t.surface);
  const subtle = mixOver(fg, SUBTLE_ALPHA[theme], t.surface.page);
  if (surfaces.some((s) => contrastRatio(fg, s) < 4.5)) return null;
  if (contrastRatio(fg, subtle) < 4.5) return null;
  if (contrastRatio(t.text.default, subtle) < 4.5) return null;
  const on = [BRAND.mono.black, BRAND.mono.white].sort(
    (a, b) => contrastRatio(b, fg) - contrastRatio(a, fg),
  )[0]!;
  if (contrastRatio(on, fg) < 4.5) return null;
  if (
    colorViolations(fg, theme).some(
      (v) => v.rule === "blue-indigo" || v.rule === "rose",
    )
  )
    return null;
  // The callout outline: the same hue, stepped toward the ground's opposite (dark: down, as the
  // existing borders are; light: up) until it is the first value that still clears 3:1 on the
  // page and on the subtle callout ground.
  const step = theme === "dark" ? -0.01 : 0.01;
  let border: string | null = null;
  for (let bl = l; bl > 0.3 && bl < 0.9; bl += step) {
    const b = oklchToHex({ l: bl, c, h });
    if (contrastRatio(b, t.surface.page) >= 3 && contrastRatio(b, subtle) >= 3)
      border = b;
    else break;
  }
  if (!border) return null;
  return { oklch: [l, c, h], fg, on, border };
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
  extra: Record<string, string> = references(theme),
): Candidate | null {
  const set = { ...others, ...extra };
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

/** The best admissible status colour in a window, kept farthest (ΔE00) from `set`. */
export function searchStatus(
  theme: Theme,
  set: Record<string, string>,
  hues: readonly [number, number],
  lightness: readonly [number, number],
  minChroma: number,
) {
  let best:
    | (ReturnType<typeof admissibleStatus> & {
        minDE00: number;
        nearest: string;
      })
    | null = null;
  for (let h = hues[0]; h <= hues[1]; h += 1)
    for (let l = lightness[0]; l <= lightness[1] + 1e-9; l += 0.01)
      for (let c = minChroma; c <= 0.26; c += 0.005) {
        const r3 = (n: number) => Math.round(n * 1000) / 1000;
        const a = admissibleStatus(theme, r3(l), r3(c), h);
        if (!a) continue;
        const { min, nearest } = minDistance(a.fg, set);
        if (
          !best ||
          min > best.minDE00 + 0.05 ||
          (Math.abs(min - best.minDE00) <= 0.05 && c > best.oklch[1])
        )
          best = { ...a, minDE00: min, nearest };
      }
  return best;
}

/** A window around an owner's starting colour: ±dh hue, ±dl lightness, >= cf of its chroma. */
function around(hex: string, dh: number, dl: number, cf: number) {
  const o = hexToOklch(hex);
  const h = Math.round(o.h);
  const l = Math.round(o.l * 100) / 100;
  return {
    hues: [h - dh, h + dh] as const,
    lightness: [l - dl, l + dl] as const,
    minChroma: Math.floor(o.c * cf * 200) / 200,
  };
}

const isMain = process.argv[1]?.endsWith("tune-accents.ts");
if (isMain) {
  // Run 2 (owner decisions after the proofs, 2026-10-03): Config becomes yellow from #ffd43b /
  // #8a6a00; Update light returns to a bright orange near #b04a00 (dark stays #fe8001); Release,
  // the only blue-green left, is re-tuned over the whole teal-to-cyan arc; then the warning status
  // moves into the amber between them. Section accents no longer keep clear of gold.
  const UPDATE_DARK = "#fe8001";
  for (const theme of ["dark", "light"] as const) {
    const a = THEME_TOKENS[theme].accent;
    const band = (theme === "dark" ? [0.73, 0.88] : [0.45, 0.6]) as readonly [
      number,
      number,
    ];
    const fixed: Record<string, string> = {
      violet: a.violet.solid,
      chartreuse: a.chartreuse.solid,
      green: a.green.solid,
      orchid: a.orchid.solid,
    };
    console.log(`\n== ${theme}`);
    // Config yellow: from 2° below the start's hue to 100° (chartreuse is 121-123° and lime
    // starts around 105°; below the start it drifts into amber and the gold, which the first
    // unbounded run did, picking #fbbc03 at 84°), ±0.05 lightness, >= 90% chroma.
    const cw = around(theme === "dark" ? "#ffd43b" : "#8a6a00", 8, 0.05, 0.9);
    const config = search(
      theme,
      fixed,
      [cw.hues[0] + 6, Math.min(cw.hues[1], 100)],
      // Light: never darker than the owner's #8a6a00. Darker scores higher (it moves away from
      // the chartreuse) but turns mustard-brown and lands on the warning amber; the run that
      // allowed it picked #7a5b01, 9.5 from warning.
      theme === "light"
        ? [cw.lightness[0] + 0.05, cw.lightness[1]]
        : cw.lightness,
      cw.minChroma,
    );
    console.log("config (yellow):", JSON.stringify(config));
    if (!config) continue;
    // Update: dark is held at the owner's #fe8001; light within ±6° and ±0.03 of #b04a00.
    let update: Candidate | null;
    if (theme === "dark") {
      const o = hexToOklch(UPDATE_DARK);
      update = search(
        theme,
        { ...fixed, yellow: config.solid },
        [Math.round(o.h), Math.round(o.h)],
        [Math.round(o.l * 100) / 100, Math.round(o.l * 100) / 100],
        Math.floor(o.c * 200) / 200,
      );
    } else {
      const uw = around("#b04a00", 6, 0.03, 0.95);
      update = search(
        theme,
        { ...fixed, yellow: config.solid },
        uw.hues,
        uw.lightness,
        uw.minChroma,
      );
    }
    console.log("update (tangerine):", JSON.stringify(update));
    if (!update) continue;
    // Release: the teal-to-cyan arc up to the blue band, the palette's lightness band, chroma at
    // least Config's old cyan's (0.125 dark, 0.085 light).
    const withBoth = {
      ...fixed,
      yellow: config.solid,
      tangerine: update.solid,
    };
    const release = search(
      theme,
      withBoth,
      [150, 214],
      band,
      theme === "dark" ? 0.125 : 0.085,
    );
    console.log("release (teal):", JSON.stringify(release));
    if (!release) continue;
    // Warning: the amber between Update and Config, kept farthest from both (solid and fg), the
    // danger tokens and the UI signed colour.
    const t = THEME_TOKENS[theme];
    const lo = Math.round(hexToOklch(update.solid).h);
    const hi = Math.round(hexToOklch(config.solid).h);
    const warning = searchStatus(
      theme,
      {
        "config solid": config.solid,
        "config fg": config.fg,
        "update solid": update.solid,
        "update fg": update.fg,
        "danger fg": t.status.danger.fg,
      },
      [lo, hi],
      // A status lightness band (the other statuses sit at 0.66-0.78 dark, 0.49-0.52 light) and a
      // chroma floor (0.13 dark; 0.10 light, where sRGB holds no more chroma for a dark amber),
      // so the search cannot win with a dull khaki or a dark brown (the first run's #9c7b31 and
      // #71330c).
      theme === "dark" ? [0.68, 0.84] : [0.47, 0.58],
      theme === "dark" ? 0.13 : 0.1,
    );
    console.log("warning (amber):", JSON.stringify(warning));
    if (warning)
      console.log(
        "  warning vs signed ΔE00",
        deltaE2000(warning.fg, t.signed.solid).toFixed(1),
        "ΔEOK",
        deltaEOK(warning.fg, t.signed.solid).toFixed(3),
        "vs danger ΔE00",
        deltaE2000(warning.fg, t.status.danger.fg).toFixed(1),
      );
  }
}
