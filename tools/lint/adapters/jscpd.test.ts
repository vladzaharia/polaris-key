/** P0-46.3: the jscpd adapter against a recorded report shape. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "./jscpd.mjs";
import { tally } from "../lint-debt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
  join(HERE, "..", "fixtures", "jscpd-report.json"),
  "utf8",
);

describe("jscpd adapter", () => {
  it("counts a clone once per file it touches", () => {
    const found = parse(fixture, { root: "/repo" });
    expect(tally(found)).toEqual({
      "packages/a/src/x.ts": { "jscpd:duplicate": 2 },
      "packages/b/src/y.ts": { "jscpd:duplicate": 2 },
      "tools/z.mjs": { "jscpd:duplicate": 1 },
    });
  });

  it("is independent of line positions", () => {
    const shifted = fixture
      .replaceAll('"start": 1,', '"start": 11,')
      .replaceAll('"end": 7', '"end": 17');
    expect(parse(shifted, { root: "/repo" })).toEqual(
      parse(fixture, { root: "/repo" }),
    );
  });

  it("relativises absolute names against the root", () => {
    const abs = JSON.stringify({
      duplicates: [
        {
          firstFile: { name: "/repo/a.ts" },
          secondFile: { name: "/repo/b.ts" },
        },
      ],
    });
    expect(parse(abs, { root: "/repo" }).map((f) => f.file)).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("throws on foreign input", () => {
    expect(() => parse("nope", { root: "/" })).toThrow();
    expect(() => parse('{"x":1}', { root: "/" })).toThrow();
    expect(() => parse('{"duplicates":[{}]}', { root: "/" })).toThrow();
  });
});
