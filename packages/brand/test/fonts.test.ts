// The web fonts: two Rubik weights (the kit ships no others), each in latin and latin-ext WOFF2
// subsets with their unicode-range, font-display: swap, and the licence files beside them.

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

describe("fonts.css", () => {
  const faces = [...fontsCss.matchAll(/@font-face \{([^}]*)\}/g)].map(
    (m) => m[1]!,
  );

  it("declares four faces: 400 and 700, latin and latin-ext", () => {
    expect(faces).toHaveLength(4);
    const keys = faces.map((f) => {
      const weight = /font-weight: (\d+);/.exec(f)![1];
      const file = /url\("\.\/([^"]+)"\)/.exec(f)![1];
      return `${weight} ${file}`;
    });
    expect(keys.sort()).toEqual([
      "400 rubik-latin-400.woff2",
      "400 rubik-latin-ext-400.woff2",
      "700 rubik-latin-700.woff2",
      "700 rubik-latin-ext-700.woff2",
    ]);
  });

  it("every face is Rubik, normal, font-display: swap, woff2", () => {
    for (const f of faces) {
      expect(f).toContain('font-family: "Rubik";');
      expect(f).toContain("font-style: normal;");
      expect(f).toContain("font-display: swap;");
      expect(f).toContain('format("woff2")');
    }
  });

  it("unicode ranges equal the ones the subsetter used", () => {
    const ranges = scriptRanges();
    for (const f of faces) {
      const file = /url\("\.\/rubik-(latin(?:-ext)?)-\d+\.woff2"\)/.exec(
        f,
      )![1]!;
      const declared = /unicode-range:\s*([^;]+);/
        .exec(f)![1]!
        .replace(/\s+/g, "");
      expect(declared).toBe(ranges[file]);
    }
  });

  it("each WOFF2 file exists and is a WOFF2 (wOF2 magic)", () => {
    for (const f of faces) {
      const file = /url\("\.\/([^"]+)"\)/.exec(f)![1]!;
      const buf = readFileSync(join(PKG, "fonts", file));
      expect(buf.subarray(0, 4).toString("latin1")).toBe("wOF2");
      expect(buf.length).toBeGreaterThan(5_000);
      expect(buf.length).toBeLessThan(40_000);
    }
  });
});

describe("licence obligations (SIL OFL 1.1)", () => {
  it("OFL.txt and FONT-NOTICE.txt ship beside the fonts, identical to the kit's", () => {
    for (const f of ["OFL.txt", "FONT-NOTICE.txt"])
      expect(readFileSync(join(PKG, "fonts", f), "utf8")).toBe(
        readFileSync(join(PKG, "kit", "source", "fonts", f), "utf8"),
      );
  });

  it("the OFL declares no Reserved Font Name, so the subsets may keep the name Rubik", () => {
    const ofl = readFileSync(join(PKG, "fonts", "OFL.txt"), "utf8");
    expect(ofl.split("-----")[0]).not.toMatch(/Reserved Font Name/i);
  });

  it("the package files list ships the fonts directory (licence travels with the binaries)", () => {
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(pkg.files).toContain("fonts");
    expect(pkg.files).toContain("kit");
  });
});
