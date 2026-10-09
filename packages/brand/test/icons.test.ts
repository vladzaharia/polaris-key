// The service icon set (BRAND.md §1.1, §7.8): the glyph table tracks tools/services.json, every
// file on disk is what the package renders, no asset carries a style attribute, the stroke follows
// the displayed size, and the tile and glyph colours clear the contrast floors in both themes.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { contrastRatio } from "../src/color.js";
import { THEME_TOKENS } from "../src/generated/tokens.js";
import {
  serviceIconFile,
  serviceIconSprite,
  serviceIconSvg,
  serviceIconTileColors,
  serviceIconTileSvg,
} from "../src/marks/icons.js";
import {
  SERVICE_ICON_IDS,
  SERVICE_ICON_TILE,
  SERVICE_ICONS,
  serviceIconStroke,
} from "../src/tokens/icons.js";
import { LUCIDE_NODES } from "../src/tokens/lucide.js";
import { SERVICE_IDS, THEMES } from "../src/tokens/source.js";

const PKG = join(import.meta.dirname, "..");
const table = JSON.parse(
  readFileSync(join(PKG, "../../tools/services.json"), "utf8"),
) as { services: { slug: string; console: { icon: string } }[] };
const ICON_DIR = join(PKG, "icons/services");

describe("service icon table", () => {
  it("has ten icons: core, every service in tools/services.json, commerce, packs", () => {
    expect([...SERVICE_ICON_IDS]).toEqual([
      "core",
      ...table.services.map((s) => s.slug),
      "commerce",
      "packs",
    ]);
    expect(SERVICE_ICON_IDS).toHaveLength(10);
  });

  it("names the glyph tools/services.json console.icon names", () => {
    for (const s of table.services)
      expect(
        SERVICE_ICONS[s.slug as keyof typeof SERVICE_ICONS].glyph,
        s.slug,
      ).toBe(s.console.icon);
  });

  it("draws every glyph from vendored lucide data", () => {
    for (const id of SERVICE_ICON_IDS)
      expect(LUCIDE_NODES[SERVICE_ICONS[id].glyph], id).toBeDefined();
  });

  it("gives Distribution a service glyph that is not the Star Cut, and Ship builds one Package glyph", () => {
    expect(SERVICE_ICONS.distribution.glyph).toBe("Waypoints");
    expect(SERVICE_ICONS.release.glyph).toBe("Package");
  });

  it("draws Commerce in the Distribution green family, Packs in none", () => {
    expect(SERVICE_ICONS.commerce.accent).toBe("distribution");
    expect(SERVICE_ICONS.packs.accent).toBeNull();
  });

  it("keeps Update and Packs out of the console's data-service set", () => {
    const off = SERVICE_ICON_IDS.filter((id) => !SERVICE_ICONS[id].dataService);
    expect(off).toEqual(["update", "packs"]);
  });

  it("only names accents that exist", () => {
    for (const id of SERVICE_ICON_IDS) {
      const a = SERVICE_ICONS[id].accent;
      if (a !== null) expect(SERVICE_IDS).toContain(a);
    }
  });
});

describe("stroke follows the displayed size", () => {
  it.each([
    [16, 2],
    [20, 2],
    [24, 1.6],
    [32, 1.6],
    [64, 1.6],
  ])("%i px draws at stroke %d", (size, stroke) => {
    expect(serviceIconStroke(size)).toBe(stroke);
    expect(serviceIconSvg("license", { size })).toContain(
      `stroke-width="${stroke}"`,
    );
  });
});

describe("files on disk", () => {
  it("are exactly what the package renders, and nothing else", () => {
    const want = new Map<string, string>();
    for (const id of SERVICE_ICON_IDS) {
      want.set(`${id}.svg`, serviceIconFile(id));
      want.set(`${id}-compact.svg`, serviceIconFile(id, true));
    }
    want.set("sprite.svg", serviceIconSprite());
    expect(readdirSync(ICON_DIR).sort()).toEqual([...want.keys()].sort());
    for (const [name, svg] of want)
      expect(readFileSync(join(ICON_DIR, name), "utf8"), name).toBe(`${svg}\n`);
  });

  it("carry no style attribute, class or script (CSP)", () => {
    for (const f of readdirSync(ICON_DIR)) {
      const svg = readFileSync(join(ICON_DIR, f), "utf8");
      expect(svg, f).not.toMatch(/\sstyle=|\sclass=|<script|\son\w+=/);
    }
  });

  it("inherit currentColor, fill none, round caps and joins", () => {
    const svg = readFileSync(join(ICON_DIR, "license.svg"), "utf8");
    expect(svg).toContain('fill="none" stroke="currentColor"');
    expect(svg).toContain('stroke-linecap="round" stroke-linejoin="round"');
  });

  it("the sprite holds both strokes of every icon", () => {
    const sprite = serviceIconSprite();
    for (const id of SERVICE_ICON_IDS) {
      expect(sprite).toContain(`id="pk-service-${id}"`);
      expect(sprite).toContain(`id="pk-service-${id}-compact"`);
    }
    expect(sprite.match(/stroke-width="2"/g)).toHaveLength(10);
    expect(sprite.match(/stroke-width="1.6"/g)).toHaveLength(10);
  });

  it("no file names a service 'Polaris Key Update'", () => {
    for (const f of readdirSync(ICON_DIR))
      expect(readFileSync(join(ICON_DIR, f), "utf8")).not.toContain(
        "Polaris Key Update",
      );
  });
});

describe("the icon tile (BRAND §7.8)", () => {
  it("has the four sizes and radii", () => {
    expect([...SERVICE_ICON_TILE.sizes]).toEqual([64, 48, 28, 20]);
    expect(SERVICE_ICON_TILE.radius).toEqual({ 64: 14, 48: 12, 28: 8, 20: 6 });
  });

  it("is a raised square with a 1 px accent border, never a solid plate", () => {
    for (const theme of THEMES)
      for (const id of SERVICE_ICON_IDS) {
        const c = serviceIconTileColors(id, theme);
        expect(c.fill).toBe(THEME_TOKENS[theme].surface.raised);
        const svg = serviceIconTileSvg(id, { theme });
        expect(svg).not.toMatch(/\sstyle=|filter|gradient|shadow/i);
        expect(svg).toContain('stroke-width="1"');
      }
  });

  it("draws the glyph at half the tile, stroke by its own size", () => {
    expect(serviceIconTileSvg("config", { size: 64 })).toContain(
      'width="32" height="32"',
    );
    expect(serviceIconTileSvg("config", { size: 64 })).toContain(
      'stroke-width="1.6"',
    );
    expect(serviceIconTileSvg("config", { size: 20 })).toContain(
      'stroke-width="2"',
    );
  });

  it.each(THEMES)(
    "clears contrast in %s: glyph 4.5:1 and border 3:1 on the tile and on the page",
    (theme) => {
      const t = THEME_TOKENS[theme];
      for (const id of SERVICE_ICON_IDS) {
        const c = serviceIconTileColors(id, theme);
        expect(
          contrastRatio(c.ink, c.fill),
          `${id} glyph`,
        ).toBeGreaterThanOrEqual(4.5);
        for (const ground of [c.fill, t.surface.page])
          expect(
            contrastRatio(c.border, ground),
            `${id} border`,
          ).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
