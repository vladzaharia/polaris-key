import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Weights are 400, 500 and 600 on every surface (brand B7). Headings and titles are
 * `font-semibold`, buttons, labels, tabs, nav and chips are `font-medium`, body is normal; 700 is
 * the wordmark only. This test fails on any bold (700 and up) weight in `src/`, in a class, a
 * numeric weight or a style, except in the allow-listed files below.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Files that may carry a 700 weight, relative to `src/` with `/` separators: the wordmark fallback. */
const ALLOW = new Set<string>([]);

const BOLD: Array<[string, RegExp]> = [
  ["font-bold", /(?<![\w-])font-(bold|extrabold|black)(?![\w-])/],
  ["font-[700+]", /font-\[(?:weight:)?[789]00\]/],
  [
    "font-weight 700+",
    /font-?[wW]eight["']?\s*[:=]\s*["']?(bold|bolder|[789]00)\b/,
  ],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.(tsx?|css|html)$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

describe("font weights", () => {
  it("uses no 700 weight outside the allow-list", () => {
    const hits: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file).split(sep).join("/");
      if (ALLOW.has(rel)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          for (const [name, re] of BOLD) {
            if (re.test(line)) hits.push(`${rel}:${i + 1} ${name}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("detects the patterns it guards", () => {
    expect(BOLD[0]![1].test('className="text-sm font-bold"')).toBe(true);
    expect(BOLD[0]![1].test('className="font-semibold"')).toBe(false);
    expect(BOLD[2]![1].test('{ fontWeight: "700" }')).toBe(true);
    expect(BOLD[2]![1].test('{ fontWeight: "600" }')).toBe(false);
  });
});
