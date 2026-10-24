/**
 * P0-46.5: the ktlint and detekt adapters (tools/lint/adapters) over fixtures of the tools' real
 * output.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as detekt } from "./adapters/detekt.mjs";
import { parse as ktlint } from "./adapters/ktlint.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");

describe("ktlint adapter", () => {
  it("takes paths relative to sdks/kotlin, one entry per error, and names a parse error", () => {
    expect(ktlint(fixture("ktlint.json"), { root: "/repo" })).toEqual([
      {
        file: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/A.kt",
        rule: "ktlint:standard:import-ordering",
      },
      {
        file: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/A.kt",
        rule: "ktlint:standard:no-blank-line-before-rbrace",
      },
      {
        file: "sdks/kotlin/core/src/main/kotlin/im/plrs/key/core/A.kt",
        rule: "ktlint:standard:import-ordering",
      },
      {
        file: "sdks/kotlin/ui/src/commonMain/kotlin/B.kt",
        rule: "ktlint:parse-error",
      },
    ]);
  });
  it("accepts an absolute path and empty output", () => {
    const one = JSON.stringify([
      { file: "/repo/sdks/kotlin/a.kt", errors: [{ rule: "standard:x" }] },
    ]);
    expect(ktlint(one, { root: "/repo" })).toEqual([
      { file: "sdks/kotlin/a.kt", rule: "ktlint:standard:x" },
    ]);
    expect(ktlint("[]", { root: "/repo" })).toEqual([]);
  });
  it("throws on foreign input and a path outside the root", () => {
    expect(() => ktlint("a.kt:1:1: x", { root: "/repo" })).toThrow();
    expect(() => ktlint('{"a":1}', { root: "/repo" })).toThrow();
    expect(() => ktlint('[{"file":"a.kt"}]', { root: "/repo" })).toThrow();
    expect(() =>
      ktlint('[{"file":"/other/a.kt","errors":[]}]', { root: "/repo" }),
    ).toThrow(/outside/);
  });
});

describe("detekt adapter", () => {
  it("maps file URIs to repo-relative paths and drops the detekt. prefix", () => {
    expect(detekt(fixture("detekt.sarif"), { root: "/repo" })).toEqual([
      {
        file: "sdks/kotlin/core/src/main/kotlin/A.kt",
        rule: "detekt:complexity.LongParameterList",
      },
      {
        file: "sdks/kotlin/core/src/main/kotlin/A.kt",
        rule: "detekt:style.MagicNumber",
      },
    ]);
  });
  it("takes a run without results", () => {
    expect(
      detekt('{"version":"2.1.0","runs":[{"results":[]}]}', { root: "/repo" }),
    ).toEqual([]);
  });
  it("throws on foreign input and a path outside the root", () => {
    expect(() => detekt("not json", { root: "/repo" })).toThrow();
    expect(() => detekt("[]", { root: "/repo" })).toThrow();
    expect(() =>
      detekt('{"version":"2.1.0","runs":[{}]}', { root: "/repo" }),
    ).toThrow();
    const out = JSON.parse(fixture("detekt.sarif"));
    out.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri =
      "file:///other/A.kt";
    expect(() => detekt(JSON.stringify(out), { root: "/repo" })).toThrow(
      /outside/,
    );
  });
});
