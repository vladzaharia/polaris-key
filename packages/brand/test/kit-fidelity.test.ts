// Kit fidelity: the in-repo kit copy is byte-identical to the shipped kit (its SHA256SUMS), the
// primitives equal the kit's tokens, and every mark, lockup and badge the package renders in
// "kit" mode reproduces the kit's own file exactly.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { GEOMETRY, SPRITE } from "../src/generated/geometry.js";
import { BADGE_TEMPLATES, LOCKUP_TEMPLATES } from "../src/generated/layouts.js";
import {
  kitLockupSvg,
  kitMarkSvg,
  kitPoweredBySvg,
  type KitVariant,
} from "../src/marks/svg.js";
import {
  ALT,
  BRAND,
  KIT_VERSION,
  OPTICAL,
  POWERED_BY,
} from "../src/tokens/primitives.js";

const KIT = join(import.meta.dirname, "..", "kit");
const read = (p: string) => readFileSync(join(KIT, p), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("the in-repo kit copy", () => {
  const sums = new Map(
    read("SHA256SUMS.txt")
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, path] = line.split(/\s+/, 2);
        return [path!, hash!] as const;
      }),
  );
  const files = walk(KIT)
    .map((p) => relative(KIT, p))
    .filter((p) => p !== "SHA256SUMS.txt");

  it("contains only files the kit's SHA256SUMS lists", () => {
    expect(files.filter((f) => !sums.has(f))).toEqual([]);
  });

  it.each(files)("%s matches the kit checksum", (f) => {
    const hash = createHash("sha256")
      .update(readFileSync(join(KIT, f)))
      .digest("hex");
    expect(hash).toBe(sums.get(f));
  });

  it("carries every directory consumers are promised", () => {
    for (const dir of [
      "01-marks",
      "02-lockups",
      "03-powered-by",
      "04-web/key",
      "04-web/update",
      "05-app-icons",
      "06-games",
      "07-social",
      "08-developer",
      "source/fonts",
    ])
      expect(statSync(join(KIT, dir)).isDirectory()).toBe(true);
  });
});

describe("primitives equal kit/08-developer/tokens.json", () => {
  const kit = JSON.parse(read("08-developer/tokens.json")) as {
    colors: Record<"dark" | "light", Record<string, string>>;
    rose: Record<"dark" | "light", string>;
    minimumServiceSize: number;
    faviconCut: number;
    goldMinimumGlyphSize: number;
    version: string;
  };

  it.each(["dark", "light"] as const)("%s colours", (g) => {
    expect(BRAND.violet[g]).toBe(kit.colors[g].body);
    expect(BRAND.star[g]).toBe(kit.colors[g].star);
    expect(BRAND.gold[g]).toBe(kit.colors[g].gold);
    expect(BRAND.text[g]).toBe(kit.colors[g].text);
    expect(BRAND.muted[g]).toBe(kit.colors[g].muted);
    expect(BRAND.page[g]).toBe(kit.colors[g].bg);
    expect(BRAND.rose[g]).toBe(kit.rose[g]);
  });

  it("size thresholds and version", () => {
    expect(OPTICAL.minimumServiceSize).toBe(kit.minimumServiceSize);
    expect(OPTICAL.faviconBelow).toBe(kit.minimumServiceSize);
    expect(OPTICAL.faviconCut).toBe(kit.faviconCut);
    expect(OPTICAL.goldMinimumGlyphSize).toBe(kit.goldMinimumGlyphSize);
    expect(KIT_VERSION).toBe(kit.version);
  });

  it("mono inks are the kit's (mono-black is the page ground, mono-white is white)", () => {
    expect(BRAND.mono.black).toBe(BRAND.page.dark);
    expect(BRAND.mono.white).toBe("#ffffff");
  });

  it("tokens.css re-exports the kit's tokens.css values verbatim", () => {
    const kitCss = read("08-developer/tokens.css");
    const ours = readFileSync(
      join(import.meta.dirname, "..", "css", "tokens.css"),
      "utf8",
    );
    for (const [, name, value] of kitCss.matchAll(
      /--(polaris-key-[a-z-]+):(#[0-9a-f]+)/g,
    ))
      expect(ours).toContain(`--${name}: ${value};`);
  });
});

describe("mark geometry equals the kit", () => {
  it("equals source/geometry.json", () => {
    expect(GEOMETRY).toEqual(JSON.parse(read("source/geometry.json")));
  });

  it("equals the paths in the kit's PolarisMark.tsx", () => {
    const tsx = read("08-developer/PolarisMark.tsx");
    const literal = /const paths = (\{.*\}) as const;/.exec(tsx)![1]!;
    const paths = JSON.parse(literal) as Record<
      string,
      Record<string, [string, string][]>
    >;
    for (const kind of ["key", "update"] as const)
      for (const cut of ["display", "service", "favicon"] as const)
        expect(GEOMETRY[kind][cut][1]).toEqual(paths[kind]![cut]);
  });

  it("equals the currentColor sprite's symbols (no gold in the sprite)", () => {
    expect(SPRITE).toBe(read("08-developer/polaris-sprite.svg"));
    for (const kind of ["key", "update"] as const)
      for (const cut of ["display", "service", "favicon"] as const) {
        const id = `polaris-${kind}-${cut}`;
        const symbol = new RegExp(
          `<symbol id="${id}" viewBox="0 0 (\\d+) \\d+">(.*?)</symbol>`,
        ).exec(SPRITE)!;
        expect(Number(symbol[1])).toBe(GEOMETRY[kind][cut][0]);
        const ds = [...symbol[2]!.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
        expect(ds).toEqual(
          GEOMETRY[kind][cut][1]
            .filter(([role]) => role !== "gold")
            .map(([, d]) => d),
        );
      }
  });

  it("the adaptive favicon.svg files use the favicon cut", () => {
    for (const kind of ["key", "update"] as const) {
      const svg = read(`04-web/${kind}/favicon.svg`);
      const ds = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
      expect(ds).toEqual(GEOMETRY[kind].favicon[1].map(([, d]) => d));
    }
  });
});

const VARIANTS: KitVariant[] = [
  "dark",
  "light",
  "mono-black",
  "mono-white",
  "currentColor",
];

describe("kit-mode renderers reproduce the kit files byte for byte", () => {
  const marks: [string, () => string][] = [];
  for (const kind of ["key", "update"] as const)
    for (const cut of ["display", "service", "favicon"] as const)
      for (const v of VARIANTS) {
        marks.push([
          `01-marks/${kind}/svg/${kind}-${cut}-${v}.svg`,
          () => kitMarkSvg(kind, cut, v),
        ]);
        if (kind === "key" && cut === "display")
          marks.push([
            `01-marks/${kind}/svg/${kind}-${cut}-signed-${v}.svg`,
            () => kitMarkSvg(kind, cut, v, true),
          ]);
      }
  for (const kind of ["key", "update"] as const)
    for (const v of ["dark", "light", "mono-black", "mono-white"] as const)
      marks.push([
        `06-games/${kind}/${v}/${kind}-16.svg`,
        () => kitMarkSvg(kind, "favicon", v),
      ]);

  it.each(marks)("%s", (path, render) => {
    expect(render()).toBe(read(path));
  });

  const lockups: [string, () => string][] = [];
  for (const kind of ["key", "update"] as const)
    for (const layout of ["horizontal", "stacked", "compact"] as const)
      for (const v of VARIANTS)
        lockups.push([
          `02-lockups/${kind}/${kind}-${layout}-${v}.svg`,
          () => kitLockupSvg(kind, layout, v),
        ]);
  it.each(lockups)("%s", (path, render) => {
    expect(render()).toBe(read(path));
  });

  const badges: [string, () => string][] = [];
  for (const t of ["transparent", "sticker", "outline"] as const)
    for (const layout of ["horizontal", "compact", "stacked"] as const)
      for (const v of ["dark", "light", "mono-black", "mono-white"] as const)
        badges.push([
          `03-powered-by/${t}/powered-by-${layout}-${v}.svg`,
          () => kitPoweredBySvg(t, layout, v),
        ]);
  it.each(badges)("%s", (path, render) => {
    expect(render()).toBe(read(path));
  });
});

describe("badge and alt facts", () => {
  it("the minimum sizes are the kit badges' own dimensions", () => {
    for (const t of ["transparent", "sticker", "outline"] as const)
      for (const layout of ["horizontal", "compact", "stacked"] as const) {
        const tpl = BADGE_TEMPLATES[t][layout];
        expect({ width: tpl.width, height: tpl.height }).toEqual(
          POWERED_BY.minimum[layout],
        );
        expect(tpl.title).toBe(POWERED_BY.phrase);
      }
  });

  it("the phrase and alt texts are the kit's", () => {
    expect(POWERED_BY.phrase).toBe("Powered by Polaris Key");
    expect(ALT).toEqual({
      key: "Polaris Key",
      update: "Polaris Key Update",
      poweredBy: "Powered by Polaris Key",
    });
    expect(LOCKUP_TEMPLATES.key.horizontal.title).toBe(ALT.key);
    expect(LOCKUP_TEMPLATES.update.horizontal.title).toBe(ALT.update);
  });

  it("the README states the same badge minimums", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/Horizontal: 376 × 144/);
    expect(readme).toMatch(/Compact: 232 × 88/);
    expect(readme).toMatch(/Stacked: 288 × 336/);
  });
});
