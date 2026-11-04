/**
 * The 4.7.2 editor run is two runners (PKEY_TEST_PART=editor-a / editor-b in sdks/godot/tools/run_tests.sh),
 * each running its half of the `ci` selection. The halves must be disjoint and together exactly `ci`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runner = readFileSync(
  new URL("../sdks/godot/tests/runner.gd", import.meta.url),
  "utf8",
);

function set(name: string): string[] {
  const m = new RegExp(`^\\t"${name}": \\[([^\\]]*?)\\],?$`, "m").exec(runner);
  if (!m) throw new Error(`runner.gd has no ${name} set`);
  return [...m[1]!.matchAll(/"([a-z_0-9]+)"/g)].map((x) => x[1]!);
}

describe("godot ci selection split", () => {
  const ci = set("ci");
  const a = set("ci_a");
  const b = set("ci_b");

  it("has no suite in both halves", () => {
    expect(a.filter((s) => b.includes(s))).toEqual([]);
  });

  it("covers ci exactly", () => {
    expect([...a, ...b].sort()).toEqual([...ci].sort());
  });

  it("has no duplicate within a set", () => {
    for (const l of [ci, a, b]) expect(new Set(l).size).toBe(l.length);
  });
});
