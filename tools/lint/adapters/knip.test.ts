/** P0-46.2: the knip adapter (`knip --reporter json` -> findings), on a fixture report. */

import { describe, expect, it } from "vitest";
import { parse } from "./knip.mjs";

const issue = (file: string, extra: Record<string, unknown[]>) => ({
  file,
  owners: [],
  files: [],
  exports: [],
  types: [],
  dependencies: [],
  devDependencies: [],
  unlisted: [],
  binaries: [],
  ...extra,
});

describe("knip adapter", () => {
  it("turns each reported item into one finding named by its issue type", () => {
    const report = {
      issues: [
        issue("packages/a/src/x.ts", {
          exports: [{ name: "a" }, { name: "b" }],
          types: [{ name: "T" }],
        }),
        issue("packages/a/src/dead.ts", {
          files: [{ name: "packages/a/src/dead.ts" }],
        }),
        issue("packages/a/package.json", {
          devDependencies: [{ name: "left-pad" }],
          owners: [{ name: "x" }],
        }),
        issue("clean.ts", {}),
      ],
    };
    const got = parse(JSON.stringify(report));
    expect(got).toEqual([
      { file: "packages/a/src/x.ts", rule: "knip:exports" },
      { file: "packages/a/src/x.ts", rule: "knip:exports" },
      { file: "packages/a/src/x.ts", rule: "knip:types" },
      { file: "packages/a/src/dead.ts", rule: "knip:files" },
      { file: "packages/a/package.json", rule: "knip:devDependencies" },
    ]);
  });

  it("throws on foreign input", () => {
    expect(() => parse("nope")).toThrow(/not JSON/);
    expect(() => parse("{}")).toThrow(/knip JSON report/);
    expect(() => parse(JSON.stringify({ issues: [{ exports: [] }] }))).toThrow(
      /without a `file`/,
    );
  });
});
