import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A link in a callout body is `fg-strong` and underlined, and that colour reads at 4.5:1 on every
 * callout ground in both themes (the accent does not: 4.25 to 4.45:1 on dark's tinted grounds).
 */

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(
  readFileSync(join(here, "..", "..", "brand", "tokens.json"), "utf8"),
) as {
  themes: Record<
    "dark" | "light",
    {
      text: { strong: string };
      status: Record<string, { subtle: string }>;
      signed: { subtle: string };
    }
  >;
};

function lum(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const ch = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * ch((n >> 16) & 255) +
    0.7152 * ch((n >> 8) & 255) +
    0.0722 * ch(n & 255)
  );
}
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("callout links", () => {
  it("are styled fg-strong and underlined in the component", () => {
    const src = readFileSync(
      join(here, "..", "src", "ui", "Callout.tsx"),
      "utf8",
    );
    expect(src).toContain("[&_a]:text-fg-strong");
    expect(src).toContain("[&_a]:underline");
  });

  describe.each(["dark", "light"] as const)("%s", (mode) => {
    const t = tokens.themes[mode];
    const grounds: [string, string][] = [
      ...["info", "success", "warning", "danger"].map(
        (k) => [k, t.status[k]!.subtle] as [string, string],
      ),
      ["signed", t.signed.subtle],
    ];
    it.each(grounds)(
      "fg-strong on %s-subtle is at least 4.5:1",
      (_k, ground) => {
        expect(contrast(t.text.strong, ground)).toBeGreaterThanOrEqual(4.5);
      },
    );
  });
});
