import { describe, expect, it } from "vitest";
import { FALLBACK_TINTS, fallbackTint } from "../src/lib/productArt.js";

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("fallback product tints", () => {
  it("are deterministic per slug and theme", () => {
    expect(fallbackTint("acme", "dark")).toBe(fallbackTint("acme", "dark"));
    const seen = new Set(
      ["acme", "djdl", "empty", "northwind", "diceroll", "x1", "x2", "x3"].map(
        (s) => fallbackTint(s, "light"),
      ),
    );
    expect(seen.size).toBeGreaterThan(3);
  });
  it("carry the card's text at 4.5:1 in both themes", () => {
    for (const t of FALLBACK_TINTS.dark)
      expect(contrast(t, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    for (const t of FALLBACK_TINTS.light)
      expect(contrast(t, "#16161a")).toBeGreaterThanOrEqual(4.5);
  });
});
