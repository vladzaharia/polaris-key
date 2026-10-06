// The web fonts (UI-KITS.md §2.1): the variable Rubik (wght 300–900) and the kit mono, JetBrains
// Mono (wght 400–600), each in latin and latin-ext WOFF2 subsets with their unicode-range and
// font-display: swap; the metric-matched fallback faces; and the licence files beside them.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");
const fontsCss = readFileSync(join(PKG, "fonts", "fonts.css"), "utf8");
const script = readFileSync(join(PKG, "scripts", "build-fonts.py"), "utf8");

function scriptRanges(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["latin", "latin-ext"]) {
    const m = new RegExp(`"${name}": ((?:\\s*"[^"]*")+),`).exec(script)!;
    out[name] = [...m[1]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]).join("");
  }
  return out;
}

const faces = [...fontsCss.matchAll(/@font-face \{([^}]*)\}/g)].map(
  (m) => m[1]!,
);
const webFaces = faces.filter((f) => f.includes("url("));
const fallbackFaces = faces.filter((f) => f.includes("local("));

describe("fonts.css", () => {
  it("declares Rubik 300–900 and JetBrains Mono 400–600, latin and latin-ext", () => {
    const keys = webFaces.map((f) => {
      const family = /font-family: "([^"]+)";/.exec(f)![1];
      const weight = /font-weight: ([\d ]+);/.exec(f)![1];
      const file = /url\("\.\/([^"]+)"\)/.exec(f)![1];
      return `${family} ${weight} ${file}`;
    });
    expect(keys.sort()).toEqual([
      "JetBrains Mono 400 600 jetbrains-mono-var-latin-ext.woff2",
      "JetBrains Mono 400 600 jetbrains-mono-var-latin.woff2",
      "Rubik 300 900 rubik-var-latin-ext.woff2",
      "Rubik 300 900 rubik-var-latin.woff2",
    ]);
  });

  it("every web face is normal, font-display: swap, woff2", () => {
    for (const f of webFaces) {
      expect(f).toContain("font-style: normal;");
      expect(f).toContain("font-display: swap;");
      expect(f).toContain('format("woff2")');
    }
  });

  it("unicode ranges equal the ones the subsetter used", () => {
    const ranges = scriptRanges();
    for (const f of webFaces) {
      const subset = /-var-(latin(?:-ext)?)\.woff2"\)/.exec(f)![1]!;
      const declared = /unicode-range:\s*([^;]+);/
        .exec(f)![1]!
        .replace(/\s+/g, "");
      expect(declared).toBe(ranges[subset]);
    }
  });

  it("each WOFF2 file exists and is a WOFF2 (wOF2 magic)", () => {
    for (const f of webFaces) {
      const file = /url\("\.\/([^"]+)"\)/.exec(f)![1]!;
      const buf = readFileSync(join(PKG, "fonts", file));
      expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(buf.length).toBeGreaterThan(5_000);
      expect(buf.length).toBeLessThan(45_000);
    }
  });

  it("the fallback faces are metric-matched local fonts, named second in the stacks", () => {
    const names = fallbackFaces.map(
      (f) => /font-family: "([^"]+)";/.exec(f)![1],
    );
    expect(names).toEqual(["Rubik Fallback", "JetBrains Mono Fallback"]);
    for (const f of fallbackFaces) {
      expect(f).toMatch(/size-adjust: [\d.]+%;/);
      expect(f).toMatch(/ascent-override: [\d.]+%;/);
      expect(f).toMatch(/descent-override: [\d.]+%;/);
      expect(f).toContain("line-gap-override: 0%;");
    }
  });

  it("the variable TTFs ship beside the WOFF2 files, unmodified (fvar present)", () => {
    for (const ttf of ["Rubik-Variable.ttf", "JetBrainsMono-Variable.ttf"]) {
      const buf = readFileSync(join(PKG, "fonts", "ttf", ttf));
      expect(buf.readUInt32BE(0)).toBe(0x00010000);
      expect(buf.includes(Buffer.from("fvar"))).toBe(true);
    }
  });
});

describe("licence obligations (SIL OFL 1.1)", () => {
  it("the Rubik OFL is the kit's, and the JetBrains Mono OFL and the notice ship beside the fonts", () => {
    expect(readFileSync(join(PKG, "fonts", "OFL.txt"), "utf8")).toBe(
      readFileSync(join(PKG, "kit", "source", "fonts", "OFL.txt"), "utf8"),
    );
    expect(
      readFileSync(join(PKG, "fonts", "OFL-JetBrainsMono.txt"), "utf8"),
    ).toContain("JetBrains Mono Project Authors");
    const notice = readFileSync(join(PKG, "fonts", "FONT-NOTICE.txt"), "utf8");
    expect(notice).toContain("Rubik");
    expect(notice).toContain("JetBrains Mono");
  });

  it("neither OFL declares a Reserved Font Name, so the subsets keep their names", () => {
    for (const f of ["OFL.txt", "OFL-JetBrainsMono.txt"]) {
      const ofl = readFileSync(join(PKG, "fonts", f), "utf8");
      expect(ofl.split("-----")[0]).not.toMatch(/Reserved Font Name/i);
    }
  });

  it("the package files list ships the fonts directory (licence travels with the binaries)", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("fonts");
    expect(pkg.files).toContain("kit");
  });
});
