// The Polaris Key Delivery marks, web files and social set, the portrait cards, the trimmed
// lockup and the hash manifest (scripts/assets.ts). The generator proves its wordmark setting on
// the kit's own cards before writing; this file checks the outputs.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CARD_KINDS,
  MARK_CUTS,
  MARK_VARIANTS,
  PORTRAIT,
} from "../scripts/assets.js";
import { LOCKUP_TEMPLATES } from "../src/generated/layouts.js";
import { lockupMetrics, lockupSvg } from "../src/marks/svg.js";
import { LOCKUP_TRIM } from "../src/tokens/primitives.js";

const PKG = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(PKG, p), "utf8");
const list = (d: string) => readdirSync(join(PKG, d)).sort();
const paths = (svg: string) =>
  [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

describe("Delivery marks", () => {
  it.each(MARK_CUTS.flatMap((c) => MARK_VARIANTS.map((v) => [c, v] as const)))(
    "%s %s: the kit's Star Cut glyph byte for byte, named Delivery",
    (cut, variant) => {
      const kit = read(`kit/01-marks/update/svg/update-${cut}-${variant}.svg`);
      const ours = read(`marks/delivery/delivery-${cut}-${variant}.svg`);
      expect(paths(ours)).toEqual(paths(kit));
      expect(ours).toContain('aria-label="Polaris Key Delivery"');
      expect(ours).toContain("<title>Polaris Key Delivery</title>");
      expect(
        ours.replaceAll("Polaris Key Delivery", "Polaris Key Update").trimEnd(),
      ).toBe(kit);
    },
  );
});

describe("Delivery web files", () => {
  it("name the app 'Polaris Key Delivery' and reuse the kit's icon bytes", () => {
    const m = JSON.parse(read("web/delivery/site.webmanifest"));
    expect(m.name).toBe("Polaris Key Delivery");
    expect(m.short_name).toBe("Key Delivery");
    const kit = JSON.parse(read("kit/04-web/update/site.webmanifest"));
    expect(m.icons).toEqual(kit.icons);
    for (const icon of m.icons as { src: string }[])
      expect(
        readFileSync(join(PKG, "web/delivery", icon.src)).equals(
          readFileSync(join(PKG, "kit/04-web/update", icon.src)),
        ),
        icon.src,
      ).toBe(true);
    expect(read("web/delivery/head-snippet.html")).toContain(
      "/branding/delivery/",
    );
  });
});

describe("Delivery social cards", () => {
  it.each(
    CARD_KINDS.flatMap((c) =>
      (["dark", "light"] as const).map((t) => [c, t] as const),
    ),
  )("%s %s: wordmark outlined, centred, named Delivery", (card, theme) => {
    const svg = read(`social/delivery/${card}-${theme}.svg`);
    expect(svg).toContain('aria-label="Polaris Key Delivery"');
    expect(svg).not.toContain("<text");
    const kit = read(`kit/07-social/update/${card}-${theme}.svg`);
    // the Star Cut group and the canvas are the kit's
    expect(svg.match(/<g transform="[^"]+">.*?<\/g>/)![0]).toBe(
      kit.match(/<g transform="[^"]+">.*?<\/g>/)![0],
    );
    expect(svg.match(/<svg [^>]*>/)![0].replace("Delivery", "Update")).toBe(
      kit.match(/<svg [^>]*>/)![0],
    );
  });
});

describe("portrait cards", () => {
  const files = [
    ["key", "dark"],
    ["key", "light"],
    ["delivery", "dark"],
    ["delivery", "light"],
  ] as const;
  it.each(files)(
    "%s %s is 1080 x 1350 with content 8 % inside every edge",
    (kind, theme) => {
      const svg = read(`social/${kind}/portrait-${theme}.svg`);
      expect(svg).toContain(
        `width="${PORTRAIT.width}" height="${PORTRAIT.height}" viewBox="0 0 ${PORTRAIT.width} ${PORTRAIT.height}"`,
      );
      expect(svg).toContain(
        `<rect width="${PORTRAIT.width}" height="${PORTRAIT.height}"`,
      );
      const mx = PORTRAIT.width * PORTRAIT.safe;
      const my = PORTRAIT.height * PORTRAIT.safe;
      const glyph =
        /<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)">/.exec(
          svg,
        )!;
      const [gx, gy, gs] = [
        Number(glyph[1]),
        Number(glyph[2]),
        Number(glyph[3]),
      ];
      expect(gx + 96 * gs * 0.1).toBeGreaterThanOrEqual(mx); // the glyph box has its own padding
      expect(gx).toBeGreaterThanOrEqual(mx - 96 * gs * 0.15);
      expect(gy).toBeGreaterThanOrEqual(my - 96 * gs * 0.15);
      const text =
        /<g fill="#[0-9a-f]{6}" transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+) -/.exec(
          svg,
        )!;
      const paths = [
        ...svg.matchAll(/<path transform="translate\((\d+) 0\)"/g),
      ].map((m) => Number(m[1]));
      const width = (paths[paths.length - 1]! + 700) * Number(text[3]); // last glyph's advance <= 700 units
      expect(Number(text[1])).toBeGreaterThanOrEqual(mx);
      expect(Number(text[1]) + width).toBeLessThanOrEqual(PORTRAIT.width - mx);
      expect(Number(text[2])).toBeLessThanOrEqual(PORTRAIT.height - my - 24);
      expect(svg).not.toMatch(/\sstyle=/);
    },
  );

  it("is the square composition moved down by half the extra height", () => {
    const sq = read("kit/07-social/key/square-dark.svg");
    const pt = read("social/key/portrait-dark.svg");
    expect(paths(pt)).toEqual(paths(sq));
    const y = (s: string) =>
      [...s.matchAll(/translate\([\d.]+ ([\d.]+)\) scale/g)].map((m) =>
        Number(m[1]),
      );
    expect(y(pt)).toEqual(y(sq).map((v) => v + 135));
  });
});

describe("trimmed horizontal lockup", () => {
  it.each(["key", "update", "delivery"] as const)(
    "%s: the constants match the template's glyph box",
    (kind) => {
      const t = LOCKUP_TEMPLATES[kind].horizontal;
      const g =
        /^<g transform="translate\(([\d.]+) ([\d.]+)\) scale\(([\d.]+)\)">/.exec(
          t.body,
        )!;
      expect(Number(g[1])).toBe(LOCKUP_TRIM.x);
      expect(Number(g[2])).toBe(LOCKUP_TRIM.y);
      expect(96 * Number(g[3])).toBe(LOCKUP_TRIM.height);
      // the wordmark's right margin is the kit's 40
      const text =
        /<g fill="\{text\}" transform="translate\(([\d.]+) \d+\) scale\(([\d.]+) -/.exec(
          t.body,
        )!;
      expect(t.height).toBe(160);
      expect(LOCKUP_TRIM.y + LOCKUP_TRIM.height + LOCKUP_TRIM.y).toBe(t.height);
      expect(Number(text[1])).toBe(140);
    },
  );

  it("keeps the kit's glyph-to-wordmark ratio: the same body, a cropped viewBox", () => {
    const kit = lockupSvg({ layout: "horizontal", theme: "dark" });
    const trim = lockupSvg({
      layout: "horizontal",
      theme: "dark",
      trim: true,
      height: 48,
    });
    const inner = (s: string) => s.slice(s.indexOf(">") + 1);
    expect(inner(trim)).toBe(inner(kit));
    expect(trim).toContain(`viewBox="16 32 ${472 - 16 - 40} 96"`);
    expect(trim).toContain('height="48"');
  });

  it("is 48 px tall in the 64 px header and shows the live bit (glyph >= 48 px)", () => {
    const m = lockupMetrics({
      layout: "horizontal",
      trim: true,
      height: 48,
      bit: "section",
    });
    expect(m.height).toBe(48);
    expect(m.glyphPx).toBe(48);
    expect(m.bit).toBe(true);
    expect(lockupSvg({ trim: true, height: 48, bit: "section" })).toContain(
      "polaris-live-bit",
    );
    expect(
      lockupMetrics({
        layout: "horizontal",
        trim: true,
        height: 47,
        bit: "section",
      }).bit,
    ).toBe(false);
  });

  it("applies to the horizontal layout only", () => {
    expect(() => lockupSvg({ layout: "stacked", trim: true })).toThrow(
      RangeError,
    );
  });

  it("names the live wordmark nowhere as text", () => {
    expect(lockupSvg({ trim: true, height: 48 })).not.toContain("<text");
  });
});

describe("GENERATED.sha256", () => {
  const lines = read("GENERATED.sha256").trimEnd().split("\n");
  const entries = lines.map((l) => {
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(l);
    expect(m, l).not.toBeNull();
    return [m![1]!, m![2]!] as const;
  });

  it("is sorted and every hash is the file's", () => {
    expect(entries.map(([, p]) => p)).toEqual(entries.map(([, p]) => p).sort());
    for (const [hash, p] of entries)
      expect(
        createHash("sha256")
          .update(readFileSync(join(PKG, p)))
          .digest("hex"),
        p,
      ).toBe(hash);
  });

  it("covers every generated text asset, the CSS and tokens.json", () => {
    const have = new Set(entries.map(([, p]) => p));
    const want = [
      "tokens.json",
      ...list("css").map((f) => `css/${f}`),
      ...list("lockups/delivery").map((f) => `lockups/delivery/${f}`),
      ...list("marks/delivery").map((f) => `marks/delivery/${f}`),
      ...list("icons/services").map((f) => `icons/services/${f}`),
      ...list("social/delivery").map((f) => `social/delivery/${f}`),
      "social/key/portrait-dark.svg",
      "social/key/portrait-light.svg",
      "web/delivery/site.webmanifest",
      "web/delivery/head-snippet.html",
    ];
    for (const p of want) expect(have.has(p), p).toBe(true);
    expect(have.size).toBe(want.length);
  });

  it("is text only, with no carriage returns, so it is the same on every platform", () => {
    for (const [, p] of entries) {
      expect(p).toMatch(/\.(svg|css|json|webmanifest|html)$/);
      expect(readFileSync(join(PKG, p), "utf8")).not.toContain("\r");
    }
  });
});

describe("Delivery assets say Delivery", () => {
  it("no generated asset outside kit/ names 'Polaris Key Update' or carries a style attribute", () => {
    for (const d of [
      "marks/delivery",
      "social/delivery",
      "icons/services",
      "lockups/delivery",
    ])
      for (const f of list(d)) {
        const s = read(`${d}/${f}`);
        expect(s, `${d}/${f}`).not.toContain("Polaris Key Update");
        expect(s, `${d}/${f}`).not.toMatch(/\sstyle=/);
      }
    for (const f of ["site.webmanifest", "head-snippet.html"])
      expect(read(`web/delivery/${f}`)).not.toContain("Update");
  });
});
