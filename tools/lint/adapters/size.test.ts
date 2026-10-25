/** P0-30.3: the size-budget adapter against the recorded `path<TAB>lines` shape. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "./size.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("size adapter", () => {
  it("emits one size:over-800 finding per listed file", () => {
    const text = readFileSync(join(HERE, "..", "fixtures", "size.txt"), "utf8");
    expect(parse(text).map((f) => f.file)).toEqual([
      "packages/worker/src/a.ts",
      "packages/worker/src/docsCsp.generated.ts",
    ]);
    expect(parse(text).every((f) => f.rule === "size:over-800")).toBe(true);
  });

  it("throws on a line that is not path<TAB>lines", () => {
    expect(() => parse("garbage\n")).toThrow(/path<TAB>lines/);
  });
});
