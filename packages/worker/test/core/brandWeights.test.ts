// B-099: BRAND.md allows 400/500/600 in UI; 700 belongs to the outlined wordmark only. The
// Worker-rendered pages and customer emails carry their CSS inline, so a stray 700 (or `bold`)
// anywhere under src/ is a regression. The wordmark is an SVG path, not a font-weight.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT } from "../paths.js";

const SRC = join(TEST_ROOT, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe("Worker-rendered CSS weights", () => {
  it("never sets font-weight 700 or bold", () => {
    const hits = walk(SRC).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [f, i + 1, l] as const)
        .filter(([, , l]) => /font-weight\s*:\s*(700|800|900|bold)/i.test(l))
        .map(([file, n]) => `${file.slice(SRC.length)}:${n}`),
    );
    expect(hits).toEqual([]);
  });

  it("every <strong>/<b> carries a weight of 600 or less (B-099)", () => {
    // A bare <strong> renders at the mail client's bold 700. The one exception is the consent
    // header's title, whose .ac-head-title strong rule in brandHtml.ts sets 600.
    const hits = walk(SRC).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((l, i) => [f, i + 1, l] as const)
        .filter(([, , l]) => /<(strong|b)(\s[^>]*)?>/i.test(l))
        .filter(([, , l]) => !l.includes("ac-head-title"))
        .filter(([, , l]) =>
          [...l.matchAll(/<(?:strong|b)(\s[^>]*)?>/gi)].some(
            (m) => !/font-weight\s*:\s*[1-6]00\b/i.test(m[1] ?? ""),
          ),
        )
        .map(([file, n]) => `${file.slice(SRC.length)}:${n}`),
    );
    expect(hits).toEqual([]);
  });

  it("the forced-colours approval button paints ButtonFace on ButtonText (B-098)", () => {
    const css = readFileSync(join(SRC, "core", "brandHtml.ts"), "utf8");
    expect(css).toMatch(
      /forced-colors: active\)\{\[data-brand=locker\] \.button:not\(\.secondary\):not\(\.link\)\{[^}]*background:ButtonFace;color:ButtonText/,
    );
  });

  it("the favicons the pages link carry no internal <style> (WebKit refuses it under the page CSP, B-108)", () => {
    for (const brand of ["key", "locker"]) {
      const file = join(
        TEST_ROOT,
        "..",
        "..",
        "brand",
        "kit",
        "04-web",
        brand,
        "favicon.svg",
      );
      let svg: string;
      try {
        svg = readFileSync(file, "utf8");
      } catch {
        continue; // the Locker favicon is emitted by the generator, not the kit
      }
      expect(svg, file).not.toContain("<style");
    }
  });
});
