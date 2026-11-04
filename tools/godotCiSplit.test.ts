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

describe("godot live lane follows dev_live", () => {
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const scope = JSON.parse(
    readFileSync(new URL("./ci-scope.json", import.meta.url), "utf8"),
  ) as {
    matrices: { godot: Record<string, { include: { part?: string }[] }> };
  };

  // Which suites a PKEY_TEST_PART runs (run_tests.sh); undefined = the unsplit `ci` selection.
  function runsDevLive(part: string | undefined): boolean {
    if (part === "matrix") return false;
    if (part === "editor-a") return set("ci_a").includes("dev_live");
    if (part === "editor-b") return set("ci_b").includes("dev_live");
    return set("ci").includes("dev_live");
  }

  // The `if:` of each step of the Godot job that starts, checks, builds or stops pkey dev.
  function liveConditions(): string[] {
    const out: string[] = [];
    for (const m of ci.matchAll(
      /- name: (?:Build the pkey dev server[^\n]*|Start pkey dev \(Godot live lane\)|Check the pkey dev lane[^\n]*|Stop pkey dev \(Godot live lane\))\n\s+if: ([^\n]+)\n/g,
    ))
      out.push(m[1]!);
    return out;
  }

  it("starts pkey dev on exactly the Linux parts that run dev_live", () => {
    const conds = liveConditions().filter((c) => c.includes("matrix.part"));
    expect(conds.length).toBe(4);
    const parts = new Set<string | undefined>([undefined]);
    for (const lane of Object.values(scope.matrices.godot))
      for (const leg of lane.include) parts.add(leg.part);
    for (const cond of conds)
      for (const part of parts) {
        const started = new Function(
          "matrix",
          `return ${cond
            .replace("always() && ", "")
            .replace(/runner\.os == 'Linux'/g, "true")};`,
        )({ part: part ?? "" });
        expect({ part, started }).toEqual({ part, started: runsDevLive(part) });
      }
  });
});
