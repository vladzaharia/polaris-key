/**
 * P0-43: the one CI scope (tools/ci-scope.mjs over tools/ci-scope.json). The `changes` job of
 * ci.yml and gate.sh read it, so these tests pin what a change runs, that every lane and matrix the
 * workflow names exists here, and that the workflow wires each one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ciOutputs, loadScope, matrixFor, selectLanes } from "./ci-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scope = loadScope();

interface Job {
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: { matrix?: unknown };
}
const ci = parseYaml(
  readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"),
) as { jobs: Record<string, Job> };

const on = (files: string[] | null) =>
  Object.entries(selectLanes(scope, files))
    .filter(([, v]) => v)
    .map(([k]) => k);

describe("lane selection", () => {
  it("runs only the Swift kit's lane for a Swift source change", () => {
    expect(on(["sdks/swift/Sources/PolarisKeyCore/Client.swift"])).toEqual([
      "swift",
    ]);
  });

  it("runs the kit lint lane for a kit's UI sources", () => {
    expect(on(["sdks/kotlin/ui/src/main/kotlin/A.kt"])).toEqual([
      "ui-kits",
      "kotlin",
      "android",
    ]);
  });

  it("runs nothing for a change no lane reads", () => {
    expect(on(["README.md", "docs/RUNBOOK.md"])).toEqual(["docs"]);
    expect(on(["examples/node-cli/README.md"])).toEqual([]);
  });

  it.each([
    "conformance/corpus/v2/cases.json",
    "packages/shared-protocol/src/index.ts",
    "packages/client-core/src/index.ts",
    "packages/brand/tokens.json",
    "tools/gen.ts",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
  ])("runs every lane for the shared input %s", (file) => {
    expect(on([file])).toEqual(Object.keys(scope.lanes));
  });

  it("runs every lane when the changed files are unknown", () => {
    expect(on(null)).toEqual(Object.keys(scope.lanes));
  });

  it("names every path it lists as a repository directory or file prefix", () => {
    const all = [
      ...scope.shared,
      ...Object.values(scope.lanes).flatMap((l) => l.paths),
    ];
    for (const p of all) expect(p).not.toMatch(/^\/|\*/);
  });
});

describe("the changes job outputs", () => {
  it("narrows a pull request to its lanes and the PR matrices", () => {
    const out = ciOutputs(scope, {
      event: "pull_request",
      files: ["sdks/python/src/polaris_key/a.py"],
    });
    expect(out.python).toBe("true");
    expect(out.swift).toBe("false");
    expect(out.full).toBe("false");
    expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(2);
    expect(JSON.parse(out["kotlin-desktop-matrix"]!).os).toEqual([
      "ubuntu-latest",
    ]);
  });

  it.each(["push", "workflow_dispatch", "schedule"])(
    "runs every lane and the full matrices on %s",
    (event) => {
      const out = ciOutputs(scope, { event, files: ["README.md"] });
      for (const lane of Object.keys(scope.lanes))
        expect(out[lane], lane).toBe("true");
      expect(out.full).toBe("true");
      expect(JSON.parse(out["python-matrix"]!).include).toHaveLength(3);
      expect(JSON.parse(out["godot-matrix"]!).include).toHaveLength(6);
    },
  );

  it("runs everything for a pull request whose changed files cannot be read", () => {
    const out = ciOutputs(scope, { event: "pull_request", files: null });
    expect(out.full).toBe("true");
    expect(out.swift).toBe("true");
  });

  it("keeps the floor and the latest of each pull-request matrix inside the full one", () => {
    for (const name of Object.keys(scope.matrices)) {
      const pr = JSON.stringify(matrixFor(scope, name, "pull_request"));
      const main = JSON.stringify(matrixFor(scope, name, "push"));
      expect(pr, name).not.toBe(main);
      const asSet = (v: string) =>
        JSON.stringify(
          Object.entries(JSON.parse(v)).map(([k, a]) => [
            k,
            (a as unknown[]).map((x) => JSON.stringify(x)),
          ]),
        );
      const prM = JSON.parse(asSet(pr)) as [string, string[]][];
      const mainM = Object.fromEntries(
        JSON.parse(asSet(main)) as [string, string[]][],
      );
      for (const [k, vals] of prM)
        for (const v of vals) expect(mainM[k], `${name}.${k}`).toContain(v);
    }
  });
});

describe("ci.yml reads the scope", () => {
  const jobs = ci.jobs;
  const needsOf = (j: Job) => [j.needs ?? []].flat();

  it("has a changes job that every scoped job needs", () => {
    expect(jobs.changes).toBeDefined();
    for (const lane of Object.keys(scope.lanes)) {
      // A lane gates a whole job (`if:`) or a step of one (the docs link check in `js`).
      const owner = Object.entries(jobs).filter(([, j]) =>
        JSON.stringify(j).includes(`needs.changes.outputs.${lane} ==`),
      );
      expect(Object.keys(jobs.changes!.outputs ?? {}), lane).toContain(lane);
      expect(owner.length, `a job gated on lane ${lane}`).toBeGreaterThan(0);
      for (const [id, j] of owner) expect(needsOf(j), id).toContain("changes");
    }
  });

  it("feeds each matrix from the changes job", () => {
    for (const name of Object.keys(scope.matrices)) {
      const text = JSON.stringify(
        Object.values(jobs).map((j) => j.strategy?.matrix ?? null),
      );
      expect(text, name).toContain(`needs.changes.outputs.${name}-matrix`);
    }
  });

  it("aggregates every other job in ci-ok, which runs always", () => {
    const ok = jobs["ci-ok"]!;
    expect(ok.if).toBe("${{ always() }}");
    const others = Object.keys(jobs).filter((id) => id !== "ci-ok");
    expect(needsOf(ok).sort()).toEqual(others.sort());
  });
});
