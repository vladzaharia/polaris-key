import { describe, expect, it } from "vitest";

import { contrastRatio } from "../src/color.js";
import {
  GOOGLE_BUTTON_FILLS,
  GOOGLE_BUTTON_FOR_SCHEME,
  GOOGLE_G_GRID,
  GOOGLE_G_PATHS,
  googleGSvg,
} from "../src/index.js";

describe("the Google sign-in mark (UI-KITS.md §3.6)", () => {
  it("is the four-colour G in Google's fixed colours", () => {
    expect(GOOGLE_G_PATHS.map((p) => p.fill)).toEqual([
      "#EA4335",
      "#4285F4",
      "#FBBC05",
      "#34A853",
    ]);
    const svg = googleGSvg();
    expect(svg).toContain(`viewBox="0 0 ${GOOGLE_G_GRID} ${GOOGLE_G_GRID}"`);
    expect(svg.match(/<path /g)).toHaveLength(4);
  });

  it("has light, dark and neutral fills whose labels read on them", () => {
    expect(Object.keys(GOOGLE_BUTTON_FILLS)).toEqual([
      "light",
      "dark",
      "neutral",
    ]);
    for (const f of Object.values(GOOGLE_BUTTON_FILLS))
      expect(contrastRatio(f.fill, f.label)).toBeGreaterThanOrEqual(7);
    expect(GOOGLE_BUTTON_FOR_SCHEME).toEqual({ light: "light", dark: "dark" });
  });
});
