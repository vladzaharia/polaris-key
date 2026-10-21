/**
 * The code themes (docs plan 8.2): colours come from the console's highlight roles, and every
 * syntax role reads at 4.5:1 or better on the code ground, in both themes.
 */

import { describe, expect, it } from "vitest";
import { LANGUAGE_LABEL, TOKEN_CLASS } from "../../admin/src/lib/highlight";
import { brandTheme, recordFromSource } from "../ec.config.mjs";

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe.each(["dark", "light"] as const)("code theme: %s", (mode) => {
  const theme = brandTheme(mode);
  const ground = theme.colors["editor.background"] as string;

  it("has a role colour for every console token kind", () => {
    const foregrounds = theme.settings
      .map((s: { settings: { foreground?: string } }) => s.settings.foreground)
      .filter(Boolean);
    expect(foregrounds.length).toBeGreaterThanOrEqual(
      Object.keys(TOKEN_CLASS).length - 1,
    );
  });

  it("reads at 4.5:1 or better on the code ground for every role", () => {
    for (const s of theme.settings as {
      scope?: string[];
      settings: { foreground?: string };
    }[]) {
      const fg = s.settings.foreground;
      if (!fg) continue;
      expect(
        contrast(fg, ground),
        `${s.scope?.[0] ?? "plain"} ${fg}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("roles are read from the console's highlight.ts", () => {
  it("TOKEN_CLASS and LANGUAGE_LABEL parse to the real objects", () => {
    expect(recordFromSource("TOKEN_CLASS")).toEqual(TOKEN_CLASS);
    expect(recordFromSource("LANGUAGE_LABEL")).toEqual(LANGUAGE_LABEL);
  });
});
