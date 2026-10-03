// The "Polaris Key Delivery" lockups (BRAND §1.1, owner decision 2026-10-03): generated from the
// bundled Rubik Bold by scripts/delivery.ts. The generator proves its wordmark setting on the
// kit's own lockups before it writes these; this file checks the outputs: the Star Cut glyph is
// the kit's byte for byte, the wordmark is outlined (no live text), every layout and colour
// variant exists and equals what the package renders.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadKit } from "../scripts/kit.js";
import { DELIVERY_TITLE, relayout } from "../scripts/delivery.js";
import { loadFont } from "../scripts/wordmark.js";
import { LOCKUP_GLYPHS, LOCKUP_TEMPLATES } from "../src/generated/layouts.js";
import {
  deliveryLockupSvg,
  lockupMetrics,
  lockupSvg,
  type KitVariant,
} from "../src/marks/svg.js";
import { ALT } from "../src/tokens/primitives.js";

const PKG = join(import.meta.dirname, "..");
const LAYOUTS = ["horizontal", "stacked", "compact"] as const;
const VARIANTS: KitVariant[] = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
  "currentColor",
];
const glyphGroup = (body: string) =>
  /^<g transform="[^"]+">.*?<\/g>/.exec(body)![0];
const textGroup = (body: string) => /<g fill="\{text\}".*<\/g>$/.exec(body)![0];

describe("Polaris Key Delivery lockups", () => {
  it("name the Star Cut 'Polaris Key Delivery'", () => {
    expect(DELIVERY_TITLE).toBe(ALT.delivery);
    for (const layout of LAYOUTS)
      expect(LOCKUP_TEMPLATES.delivery[layout].title).toBe(
        "Polaris Key Delivery",
      );
    expect(lockupSvg({ kind: "delivery" })).toContain(
      'aria-label="Polaris Key Delivery"',
    );
  });

  it.each(LAYOUTS)(
    "%s: the Star Cut glyph is the kit's, byte for byte",
    (layout) => {
      const kit = glyphGroup(LOCKUP_TEMPLATES.update[layout].body);
      const ours = glyphGroup(LOCKUP_TEMPLATES.delivery[layout].body);
      // Same paths and scale; only the stacked layout re-centres the group on its wider canvas.
      const paths = (g: string) => g.replace(/^<g transform="[^"]+">/, "");
      expect(paths(ours)).toBe(paths(kit));
      expect(ours.match(/scale\([^)]+\)/)![0]).toBe(
        kit.match(/scale\([^)]+\)/)![0],
      );
      if (layout !== "stacked")
        expect(ours.slice(0, ours.indexOf(">"))).toBe(
          kit.slice(0, kit.indexOf(">")),
        );
      expect(LOCKUP_GLYPHS.delivery[layout]).toEqual(
        LOCKUP_GLYPHS.update[layout],
      );
    },
  );

  it.each(LAYOUTS)(
    "%s: the wordmark is outlined Rubik Bold at the kit's scale and baseline",
    (layout) => {
      const kit = textGroup(LOCKUP_TEMPLATES.update[layout].body);
      const ours = textGroup(LOCKUP_TEMPLATES.delivery[layout].body);
      const head = (g: string) => / (\d+)\) scale\(([\d.]+) /.exec(g)!.slice(1);
      expect(head(ours)).toEqual(head(kit));
      expect(ours).not.toContain("<text");
      // "Polaris Key " is the same run of glyphs as the kit's, at the same pen positions.
      const firstTwelve = (g: string) =>
        g.split("<path").slice(1, 13).join("<path");
      expect(firstTwelve(ours)).toBe(firstTwelve(kit));
      expect(ours.split("<path").length - 1).toBe(
        "Polaris Key Delivery".length,
      );
    },
  );

  it("the setting reproduces the kit's own lockups (the generator's proof)", () => {
    const kit = loadKit(join(PKG, "kit"));
    const font = loadFont(join(PKG, "kit/source/fonts/Rubik-Bold.ttf"));
    for (const kind of ["key", "update"] as const)
      for (const layout of LAYOUTS) {
        const t = kit.lockups[kind][layout]!;
        expect(relayout(font, t, layout, t.title)).toEqual(t);
      }
  });

  it("keeps the kit's clear space: a quarter of the glyph on every side, at least", () => {
    for (const layout of LAYOUTS) {
      const t = LOCKUP_TEMPLATES.delivery[layout];
      const kitT = LOCKUP_TEMPLATES.update[layout];
      const m = lockupMetrics({ kind: "delivery", layout });
      expect(m.height).toBe(kitT.height);
      expect(t.width).toBeGreaterThanOrEqual(kitT.width);
      const x = Number(
        /translate\(([\d.]+) \d+\) scale\(0\.0/.exec(t.body)![1],
      );
      expect(x).toBeGreaterThanOrEqual(m.glyphPx / 4);
    }
  });

  it.each(LAYOUTS.flatMap((l) => VARIANTS.map((v) => [l, v] as const)))(
    "lockups/delivery/delivery-%s-%s.svg is what the package renders",
    (layout, variant) => {
      const file = readFileSync(
        join(PKG, "lockups", "delivery", `delivery-${layout}-${variant}.svg`),
        "utf8",
      );
      expect(file).toBe(`${deliveryLockupSvg(layout, variant)}\n`);
    },
  );
});
