import { describe, expect, it } from "vitest";
import {
  LOCKER_TOKENS,
  SERVICE_ACCENTS,
  THEME_TOKENS,
} from "@polaris-key/brand";
import {
  contrastRatio,
  hexToOklab,
  oklabToRgb,
  toHex,
} from "@polaris-key/brand/color";
import { BUTTON_VARIANTS } from "../src/ui/classes.js";

/**
 * B-017: the filled primary and danger buttons lightened 10 % toward white on hover, which took a
 * white label on a mid accent below 4.5:1 in light (Config 4.22, Update 3.92). The hover now
 * mixes 10 % toward the lightness-inverted `-on` colour (a white label darkens the fill, a dark
 * label lightens it). This models that CSS in OKLab and checks every filled pairing.
 */
function hover(solid: string, on: string): string {
  const s = hexToOklab(solid);
  const o = hexToOklab(on);
  const target = { l: 1 - o.l, a: 0, b: 0 };
  const m = {
    l: s.l * 0.9 + target.l * 0.1,
    a: s.a * 0.9,
    b: s.b * 0.9,
  };
  return toHex(oklabToRgb(m));
}

describe("filled button hover keeps the label readable", () => {
  it("the variants mix toward the inverted label colour, never toward white", () => {
    for (const v of ["primary", "danger", "destructive"] as const) {
      expect(BUTTON_VARIANTS[v]).toContain("oklch(from_var(--pk-");
      expect(BUTTON_VARIANTS[v]).not.toContain("white_10%");
    }
  });
  for (const theme of ["dark", "light"] as const) {
    const pairs: [string, string, string][] = [
      ...Object.entries(SERVICE_ACCENTS[theme]).map(
        ([k, a]) => [k, a.solid, a.on] as [string, string, string],
      ),
      ["locker", LOCKER_TOKENS[theme].solid, LOCKER_TOKENS[theme].on],
      [
        "danger",
        THEME_TOKENS[theme].status.danger.fg,
        THEME_TOKENS[theme].status.danger.on,
      ],
    ];
    for (const [name, solid, on] of pairs)
      it(`${name} (${theme}) at hover reaches 4.5:1`, () => {
        // Only pairings that clear 4.5:1 at rest are filled-button pairings.
        if (contrastRatio(solid, on) < 4.5) return;
        expect(contrastRatio(hover(solid, on), on)).toBeGreaterThanOrEqual(4.5);
      });
  }
});
