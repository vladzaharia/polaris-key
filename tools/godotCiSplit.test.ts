/**
 * The Godot CI legs (sdks/godot/tools/run_tests.sh, tools/ci-scope.json): every Linux engine is an editor
 * leg, a release-template leg where it has one, and UI matrix legs. The editor and template legs run `ci`
 * as four parallel processes (ci_p1..ci_p4), the matrix as one job per presentation path and, for the
 * long ones, two jobs per path over a shard range. These tests hold the sets, the ranges and the legs
 * so every suite runs exactly once per engine and every matrix case runs.
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

  // The parallel editor / template processes: every `ci` suite in exactly one of the four sets.
  const parallel = [1, 2, 3, 4].map((i) => set(`ci_p${i}`));

  it("splits ci into four disjoint parallel sets that together are exactly ci", () => {
    const all = parallel.flat();
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual([...ci].sort());
    for (const p of parallel) expect(p.length).toBeGreaterThan(0);
  });

  it("keeps the heavy suites apart, so no parallel set holds two of the four longest", () => {
    for (const p of parallel)
      expect(
        p.filter((s) => ["packs", "ui", "connect"].includes(s)).length,
      ).toBeLessThanOrEqual(1);
  });

  it("has run_tests.sh run exactly those four sets for ci, in the editor and the template step", () => {
    const sh = readFileSync(
      new URL("../sdks/godot/tools/run_tests.sh", import.meta.url),
      "utf8",
    );
    expect(sh).toContain("for g in 1 2 3 4; do");
    expect(sh).toContain('"ci_p$g"');
    expect(sh).toContain("run_selection editor launch_editor");
    expect(sh).toContain("run_selection template launch_template");
    // Each parallel process has its own HOME and TMPDIR.
    expect(sh).toContain('RUN_HOME="$RUN_DIR/home-$name-p$g"');
    expect(sh).toContain('TMPDIR="$RUN_DIR/tmp-$name-p$g"');
  });
});

describe("godot live lane runs dev_live on one leg", () => {
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const scope = JSON.parse(
    readFileSync(new URL("./ci-scope.json", import.meta.url), "utf8"),
  ) as {
    matrices: {
      godot: Record<string, { include: { godot: string; part?: string }[] }>;
    };
  };

  // The `if:` of each step of the Godot job that starts, checks, builds or stops pkey dev.
  function liveConditions(): string[] {
    const out: string[] = [];
    for (const m of ci.matchAll(
      /- name: (?:Build the pkey dev server[^\n]*|Start pkey dev \(Godot live lane\)|Check the pkey dev lane[^\n]*|Stop pkey dev \(Godot live lane\))\n\s+if: ([^\n]+)\n/g,
    ))
      out.push(m[1]!);
    return out;
  }

  it("has no ci set run dev_live (it is not in any selection a leg runs)", () => {
    for (const name of [
      "ci",
      "ci_a",
      "ci_b",
      "ci_p1",
      "ci_p2",
      "ci_p3",
      "ci_p4",
    ])
      expect(set(name)).not.toContain("dev_live");
  });

  it("has run_tests.sh add dev_live to the editor step's last process only under PKEY_TEST_DEV_LIVE", () => {
    const sh = readFileSync(
      new URL("../sdks/godot/tools/run_tests.sh", import.meta.url),
      "utf8",
    );
    expect(sh).toContain(
      '[ "$g" = 4 ] && [ "$name" = editor ] && [ "${PKEY_TEST_DEV_LIVE:-0}" = 1 ] && sel="$sel,dev_live"',
    );
  });

  it("sets PKEY_TEST_DEV_LIVE and starts pkey dev on exactly one leg: the 4.7.2 editor", () => {
    const conds = liveConditions().filter((c) => c.includes("matrix.part"));
    expect(conds.length).toBe(4);
    expect(ci).toContain(
      'if [ "${{ matrix.godot }}" = 4.7.2 ] && [ "${{ matrix.part }}" = editor ]; then export PKEY_TEST_DEV_LIVE=1; fi',
    );
    const legs = new Map<string, { godot: string; part: string }>();
    for (const lane of Object.values(scope.matrices.godot))
      for (const leg of lane.include)
        legs.set(`${leg.godot}/${leg.part ?? ""}`, {
          godot: leg.godot,
          part: leg.part ?? "",
        });
    for (const cond of conds) {
      const started = [...legs.values()].filter((leg) =>
        new Function(
          "matrix",
          `return ${cond
            .replace("always() && ", "")
            .replace(/runner\.os == 'Linux'/g, "true")};`,
        )(leg),
      );
      expect(started).toEqual([{ godot: "4.7.2", part: "editor" }]);
    }
  });
});

describe("godot legs split every Linux engine", () => {
  type Leg = {
    name: string;
    godot: string;
    os: string;
    part?: string;
    template: string;
    ui_paths?: string;
    ui_shards?: string;
    ui_range?: string;
  };
  const scope = JSON.parse(
    readFileSync(new URL("./ci-scope.json", import.meta.url), "utf8"),
  ) as { matrices: { godot: Record<string, { include: Leg[] }> } };
  const publish = readFileSync(
    new URL("../.github/workflows/publish-sdks.yml", import.meta.url),
    "utf8",
  );
  const ci = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );

  for (const [lane, { include }] of Object.entries(scope.matrices.godot)) {
    const linux = include.filter((l) => l.os === "ubuntu-latest");
    const engines = [...new Set(linux.map((l) => l.godot))];

    it(`runs each ${lane} Linux engine as one editor leg, UI matrix legs, and the release template where it has one`, () => {
      expect(linux.every((l) => l.part)).toBe(true);
      for (const godot of engines) {
        const legs = linux.filter((l) => l.godot === godot);
        const withTemplate = legs.some((l) => l.template);
        const parts = legs.map((l) => l.part!);
        expect(parts.filter((p) => p === "editor")).toHaveLength(1);
        expect(parts.filter((p) => p === "template")).toHaveLength(
          withTemplate ? 1 : 0,
        );
        expect(parts.filter((p) => p === "matrix").length).toBeGreaterThan(0);
        expect(parts.length).toBe(
          parts.filter((p) => ["editor", "template", "matrix"].includes(p))
            .length,
        );
        // A template is fetched exactly for the template part.
        for (const l of legs)
          expect(Boolean(l.template)).toBe(l.part === "template");
      }
    });

    it(`covers every UI matrix case of every ${lane} engine once: each path's shard ranges partition its shards`, () => {
      for (const godot of engines) {
        const legs = linux.filter(
          (l) => l.godot === godot && l.part === "matrix",
        );
        const paths = [...new Set(legs.map((l) => l.ui_paths))].sort();
        // The newest engine runs both presentation paths; every other engine its own default.
        expect(paths).toEqual(godot === "4.7.2" ? ["0", "1"] : ["auto"]);
        for (const path of paths) {
          const ofPath = legs.filter((l) => l.ui_paths === path);
          const shards = Number(ofPath[0]!.ui_shards);
          expect(ofPath.every((l) => Number(l.ui_shards) === shards)).toBe(
            true,
          );
          const owned: number[] = [];
          for (const l of ofPath) {
            const m = /^(\d+)-(\d+)$/.exec(l.ui_range!);
            expect(m, l.name).not.toBeNull();
            for (let i = Number(m![1]); i <= Number(m![2]); i++) owned.push(i);
          }
          expect(owned.sort((x, y) => x - y)).toEqual(
            Array.from({ length: shards }, (_, i) => i),
          );
          // No matrix job runs more than four processes (a hosted runner has 4 vCPUs).
          for (const l of ofPath) {
            const m = /^(\d+)-(\d+)$/.exec(l.ui_range!)!;
            expect(Number(m[2]) - Number(m[1]) + 1).toBeLessThanOrEqual(4);
          }
        }
      }
    });

    it(`runs gdlint on exactly one ${lane} leg`, () => {
      const m = /name: GDScript lint \(gdlint\)\n\s+if: ([^\n]+)\n/.exec(ci);
      expect(m).not.toBeNull();
      const cond = m![1]!.replace(/runner\.os == 'Linux'/g, "true");
      const runs = include.filter((l) =>
        l.os !== "ubuntu-latest"
          ? false
          : new Function("matrix", `return ${cond};`)(l),
      );
      expect(runs.map((l) => l.name)).toHaveLength(1);
      expect(runs[0]!.part).toBe("editor");
    });
  }

  it("runs the publish workflow's Godot test as the same three parts, in parallel", () => {
    const m = /godot-test:[\s\S]*?part: \[([^\]]+)\]/.exec(publish);
    expect(m?.[1]!.split(",").map((s) => s.trim())).toEqual([
      "editor",
      "matrix",
      "template",
    ]);
    expect(publish).toContain('PKEY_TEST_PART="${{ matrix.part }}"');
    expect(publish).toContain("PKEY_TEST_PARALLEL=1");
  });

  it("has the ci workflow pass the matrix leg's path, shard count and range, and run the parts in parallel", () => {
    expect(ci).toContain('PKEY_UI_MATRIX_PATHS="${{ matrix.ui_paths }}"');
    expect(ci).toContain('PKEY_UI_MATRIX_SHARDS="${{ matrix.ui_shards }}"');
    expect(ci).toContain('PKEY_UI_MATRIX_SHARD_RANGE="${{ matrix.ui_range }}"');
    expect(ci).toContain("export PKEY_TEST_PARALLEL=1");
  });
});
