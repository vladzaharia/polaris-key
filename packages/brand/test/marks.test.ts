// Mark rules: optical-cut selection, the gold/section bit, lockup bit suppression and the badge
// minimum sizes.

import { describe, expect, it } from "vitest";

import { SERVICE_ACCENTS } from "../src/generated/tokens.js";
import {
  badgeSize,
  bitVisible,
  clearSpace,
  opticalCut,
  resolveBitFill,
} from "../src/marks/core.js";
import {
  lockupMetrics,
  lockupSvg,
  markParts,
  markSvg,
  poweredBySvg,
} from "../src/marks/svg.js";
import { sectionBit, serviceAccent } from "../src/tokens/services.js";
import { BRAND, POWERED_BY } from "../src/tokens/primitives.js";
import { SERVICE_IDS } from "../src/tokens/source.js";

const BIT_PATH = "M70 85 L84 71 L90 77 L76 91 Z";

describe("optical cut by displayed size", () => {
  it.each([
    [12, "favicon"],
    [16, "favicon"],
    [23, "favicon"],
    [23.9, "favicon"],
    [24, "service"],
    [28, "service"],
    [32, "service"],
    [33, "display"],
    [40, "display"],
    [48, "display"],
    [96, "display"],
    [512, "display"],
  ] as const)("%d px -> %s", (size, cut) => {
    expect(opticalCut(size)).toBe(cut);
    expect(markParts({ size }).cut).toBe(cut);
  });

  it("the viewBox follows the cut's grid", () => {
    expect(markSvg({ size: 16 })).toContain('viewBox="0 0 16 16"');
    expect(markSvg({ size: 24 })).toContain('viewBox="0 0 24 24"');
    expect(markSvg({ size: 32 })).toContain('viewBox="0 0 24 24"');
    expect(markSvg({ size: 48 })).toContain('viewBox="0 0 96 96"');
  });
});

describe("the gold terminal bit", () => {
  it.each([16, 24, 32, 40, 47])("never below 48 px (%d px, signed)", (size) => {
    expect(markSvg({ size, signed: true })).not.toContain(BIT_PATH);
    expect(bitVisible("key", size)).toBe(false);
  });

  it.each([48, 64, 96, 256])("at %d px only when signed", (size) => {
    expect(markSvg({ size })).not.toContain(BIT_PATH);
    expect(markSvg({ size, signed: true })).toContain(
      `<path d="${BIT_PATH}" fill="#ffc24d"></path>`,
    );
    expect(markSvg({ size, signed: true, theme: "light" })).toContain(
      `<path d="${BIT_PATH}" fill="#d07a00"></path>`,
    );
  });

  it("the Update mark has no bit at any size", () => {
    for (const size of [16, 48, 96]) {
      expect(
        markParts({ kind: "update", size, signed: true }).parts.map(
          (p) => p.role,
        ),
      ).not.toContain("gold");
      expect(bitVisible("update", size)).toBe(false);
    }
  });

  it("mono draws every part in one ink, the bit included", () => {
    const parts = markParts({ size: 96, theme: "mono", signed: true }).parts;
    expect(parts).toHaveLength(4);
    expect(new Set(parts.map((p) => p.fill))).toEqual(
      new Set(["currentColor"]),
    );
  });

  it("colours match the kit component (body violet, star white/violet)", () => {
    const dark = markParts({ size: 96, theme: "dark" }).parts;
    expect(dark.map((p) => p.fill)).toEqual([
      BRAND.violet.dark,
      BRAND.violet.dark,
      BRAND.star.dark,
    ]);
    const light = markParts({ size: 96, theme: "light" }).parts;
    expect(light.map((p) => p.fill)).toEqual([
      BRAND.violet.light,
      BRAND.violet.light,
      BRAND.star.light,
    ]);
  });
});

describe("the section bit (bit override)", () => {
  it.each(SERVICE_IDS.filter((s) => s !== "core"))(
    "%s takes its accent",
    (id) => {
      for (const theme of ["dark", "light"] as const) {
        const fill = SERVICE_ACCENTS[theme][id].solid;
        expect(sectionBit(id, theme)).toBe(fill);
        expect(serviceAccent(id, theme).bit).toBe(fill);
        expect(resolveBitFill(id, theme)).toBe(fill);
        expect(markSvg({ size: 48, theme, bit: id })).toContain(
          `<path d="${BIT_PATH}" fill="${fill}"></path>`,
        );
      }
    },
  );

  it("core (the platform) keeps the kit gold", () => {
    expect(sectionBit("core", "dark")).toBe(BRAND.gold.dark);
    expect(sectionBit("core", "light")).toBe(BRAND.gold.light);
    expect(resolveBitFill("core", "dark")).toBe(BRAND.gold.dark);
    expect(resolveBitFill("gold", "light")).toBe(BRAND.gold.light);
  });

  it("no bit below the minimum size, whatever the override", () => {
    for (const size of [16, 24, 32, 40, 47])
      for (const bit of ["license", "core", "section", "#00ff00"] as const)
        expect(markSvg({ size, bit })).not.toContain(BIT_PATH);
  });

  it('"section" follows tokens.css with a gold fallback and the transition class', () => {
    const svg = markSvg({ size: 48, bit: "section" });
    expect(svg).toContain(
      `<path d="${BIT_PATH}" fill="#ffc24d" style="fill:var(--pk-section-bit, #ffc24d)" class="polaris-section-bit"></path>`,
    );
  });

  it("the star never changes: same fill, no class, no style, whatever the bit", () => {
    for (const bit of ["license", "section", "#123456"] as const) {
      const star = markParts({ size: 96, bit }).parts.find(
        (p) => p.role === "star",
      )!;
      expect(star.fill).toBe(BRAND.star.dark);
      expect(star.style).toBeUndefined();
      expect(star.className).toBeUndefined();
    }
  });

  it("accepts CSS colours and refuses anything else", () => {
    expect(resolveBitFill("#abc", "dark")).toBe("#abc");
    expect(resolveBitFill("var(--brand-x)", "dark")).toBe("var(--brand-x)");
    expect(resolveBitFill("oklch(0.7 0.1 150)", "dark")).toBe(
      "oklch(0.7 0.1 150)",
    );
    expect(() => resolveBitFill('red" onload="x', "dark")).toThrow();
    expect(() => resolveBitFill("url(#x)", "dark")).toThrow();
  });

  it("the kit's own rule is unchanged without an override: unsigned shows no bit", () => {
    expect(markSvg({ size: 96 })).not.toContain(BIT_PATH);
  });
});

describe("accessibility", () => {
  it("title gives role=img and a label; no title is decorative", () => {
    expect(markSvg({ title: "Polaris Key" })).toContain(
      'role="img" aria-label="Polaris Key"><title>Polaris Key</title>',
    );
    expect(markSvg({})).toContain('aria-hidden="true"');
    expect(markSvg({})).not.toContain("<title>");
  });

  it("titles are escaped", () => {
    expect(markSvg({ title: '<b>"x"</b>' })).toContain(
      "&lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
  });

  it("lockups and badges default to the kit alt text, and '' is decorative", () => {
    expect(lockupSvg({})).toContain('aria-label="Polaris Key"');
    expect(lockupSvg({ kind: "update" })).toContain(
      'aria-label="Polaris Key Update"',
    );
    expect(poweredBySvg({})).toContain('aria-label="Powered by Polaris Key"');
    expect(lockupSvg({ title: "" })).toContain('aria-hidden="true"');
  });
});

describe("lockups", () => {
  it("natural size is the kit's, with the bit (the kit's horizontal lockup is signed)", () => {
    const m = lockupMetrics({ layout: "horizontal" });
    expect([m.width, m.height, m.glyphPx, m.bit]).toEqual([472, 160, 96, true]);
    expect(lockupSvg({})).toContain('fill="#ffc24d" d="M70 85');
  });

  it("drops the bit once the glyph renders below 48 px", () => {
    // horizontal: glyph is 96/160 of the height, so 80 px tall is the threshold.
    expect(lockupMetrics({ height: 80 }).bit).toBe(true);
    expect(lockupMetrics({ height: 79 }).bit).toBe(false);
    expect(lockupSvg({ height: 79 })).not.toContain("M70 85");
    // stacked: glyph is 136/300 of the height.
    expect(lockupMetrics({ layout: "stacked", height: 106 }).bit).toBe(true);
    expect(lockupMetrics({ layout: "stacked", height: 105 }).bit).toBe(false);
  });

  it("the compact lockup uses the service cut and never carries a bit", () => {
    const m = lockupMetrics({ layout: "compact", height: 640 });
    expect(m.cut).toBe("service");
    expect(m.bit).toBe(false);
  });

  it("the section bit applies to the lockup too", () => {
    const svg = lockupSvg({ bit: "config" });
    expect(svg).toContain(
      `fill="${SERVICE_ACCENTS.dark.config.solid}" d="${BIT_PATH}"`,
    );
    expect(lockupSvg({ bit: "section", theme: "light" })).toContain(
      `style="fill:var(--pk-section-bit, #d07a00)" class="polaris-section-bit"`,
    );
    expect(lockupSvg({ signed: false })).not.toContain(BIT_PATH);
  });

  it("width follows the aspect ratio", () => {
    expect(lockupSvg({ height: 80 })).toContain('width="236" height="80"');
  });
});

describe("badge minimum sizes", () => {
  it.each(Object.entries(POWERED_BY.minimum))(
    "%s never renders below its minimum",
    (layout, min) => {
      const l = layout as keyof typeof POWERED_BY.minimum;
      expect(badgeSize(l)).toEqual(min);
      expect(badgeSize(l, 10)).toEqual(min);
      expect(badgeSize(l, min.width - 1)).toEqual(min);
      expect(badgeSize(l, Number.NaN)).toEqual(min);
      const big = badgeSize(l, min.width * 2);
      expect(big.width).toBe(min.width * 2);
      expect(big.height).toBe(min.height * 2);
      expect(poweredBySvg({ layout: l, width: 1 })).toContain(
        `width="${min.width}" height="${min.height}"`,
      );
    },
  );

  it("the badge keeps its full padded canvas (viewBox is the kit's)", () => {
    expect(poweredBySvg({ layout: "horizontal", width: 752 })).toContain(
      'width="752" height="288" viewBox="0 0 376 144"',
    );
  });

  it("clear space is a quarter of the glyph height", () => {
    expect(clearSpace(48)).toBe(12);
  });
});
