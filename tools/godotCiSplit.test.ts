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

describe("godot legs split every Linux engine", () => {
  type Leg = { godot: string; os: string; part?: string; template: string };
  const scope = JSON.parse(
    readFileSync(new URL("./ci-scope.json", import.meta.url), "utf8"),
  ) as { matrices: { godot: Record<string, { include: Leg[] }> } };
  const publish = readFileSync(
    new URL("../.github/workflows/publish-sdks.yml", import.meta.url),
    "utf8",
  );

  for (const [lane, { include }] of Object.entries(scope.matrices.godot)) {
    it(`runs each ${lane} Linux engine as editor A, editor B and the UI matrix, plus the release template where it has one`, () => {
      const linux = include.filter((l) => l.os === "ubuntu-latest");
      expect(linux.every((l) => l.part)).toBe(true);
      for (const godot of new Set(linux.map((l) => l.godot))) {
        const legs = linux.filter((l) => l.godot === godot);
        const parts = legs.map((l) => l.part!).sort();
        const withTemplate = legs.some((l) => l.template);
        expect(parts).toEqual(
          (withTemplate
            ? ["editor-a", "editor-b", "matrix", "template"]
            : ["editor-a", "editor-b", "matrix"]
          ).sort(),
        );
        // A template is fetched exactly for the template part.
        for (const l of legs)
          expect(Boolean(l.template)).toBe(l.part === "template");
      }
    });
  }

  it("runs the publish workflow's Godot test as the same four parts", () => {
    const m = /godot-test:[\s\S]*?part: \[([^\]]+)\]/.exec(publish);
    expect(m?.[1]!.split(",").map((s) => s.trim())).toEqual([
      "editor-a",
      "editor-b",
      "matrix",
      "template",
    ]);
    expect(publish).toContain('PKEY_TEST_PART="${{ matrix.part }}"');
  });
});
