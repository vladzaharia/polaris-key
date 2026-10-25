/** P0-46.6: the swift-format adapter over a fixture of `swift format lint` output. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "./swift-format.mjs";

const fixture = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "fixtures",
    "swift-format.txt",
  ),
  "utf8",
);

describe("swift-format adapter", () => {
  it("takes paths relative to sdks/swift or absolute, and names a rule-less error", () => {
    expect(parse(fixture, { root: "/repo" })).toEqual([
      {
        file: "sdks/swift/Sources/PolarisKeyCore/Copy.generated.swift",
        rule: "swift-format:AlwaysUseLowerCamelCase",
      },
      {
        file: "sdks/swift/Sources/PolarisKeyCore/Discovery.swift",
        rule: "swift-format:OrderedImports",
      },
      {
        file: "sdks/swift/Sources/PolarisKeyCore/Discovery.swift",
        rule: "swift-format:LineLength",
      },
      {
        file: "sdks/swift/Tests/PolarisKeyTests/T.swift",
        rule: "swift-format:syntax-error",
      },
    ]);
  });
  it("takes empty output", () => {
    expect(parse("", { root: "/repo" })).toEqual([]);
  });
  it("throws on foreign input and on a path outside the root", () => {
    expect(() => parse('{"a":1}', { root: "/repo" })).toThrow();
    expect(() =>
      parse("/other/a.swift:1:1: warning: [LineLength] x", { root: "/repo" }),
    ).toThrow(/outside/);
  });
});
