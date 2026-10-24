/**
 * AX-04.1: `pnpm gate` (tools/gate.mjs). The plan over fixture file lists, flag parsing, the retry
 * and the heavy prefix with a fake runner.
 */

import { describe, expect, it } from "vitest";
import {
  ciAlsoRuns,
  commandFor,
  parseFlags,
  plan,
  runSteps,
  STEPS,
  type GateContext,
  type GateIo,
} from "./gate.mjs";

const ALWAYS = [
  "install",
  "build",
  "gen",
  "typecheck",
  "test",
  "lint",
  "lint-ts",
  "skills",
];
const ran = (files: string[] | null, flags = {}) =>
  plan(files, flags)
    .steps.filter((s) => s.run)
    .map((s) => s.id);
const beyondAlways = (files: string[] | null) =>
  ran(files).filter((id) => !ALWAYS.includes(id));

describe("STEPS", () => {
  it("keeps gate.sh's numbers 1-17 in order", () => {
    expect(STEPS.map((s) => s.n)).toEqual(STEPS.map((_, i) => i + 1));
    expect(STEPS.slice(0, 17).map((s) => s.id)).toEqual([
      ...ALWAYS.slice(0, 2),
      "docs-build",
      ...ALWAYS.slice(2, 6),
      "admin-build",
      "assemble",
      "check-links",
      "workerd-typecheck",
      "workerd-test",
      "python",
      "swift",
      "godot",
      "format",
      "admin-e2e",
    ]);
  });
  it("appends step 23 skills, always on, as one root script", () => {
    const s = STEPS[22]!;
    expect([s.n, s.id, s.lane]).toEqual([23, "skills", null]);
    expect(s.argv({} as never)).toEqual(["pnpm", "skills:all"]);
  });
  it("appends the P0-46 lint steps as 18-22 with their lanes", () => {
    expect(
      STEPS.slice(17, 22).map((s) => [s.n, s.id, s.lane, !!s.heavy]),
    ).toEqual([
      [18, "lint-ts", null, false],
      [19, "lint-python", "python", false],
      [20, "lint-swift", "swift-floor", false],
      [21, "lint-kotlin", "kotlin", true],
      [22, "lint-godot", "godot", false],
    ]);
  });
});

describe("plan", () => {
  it("a docs/ change runs the always steps plus docs-build and check-links", () => {
    expect(beyondAlways(["docs/RUNBOOK.md"])).toEqual([
      "docs-build",
      "check-links",
    ]);
  });
  it("a packages/docs/ change also runs the workerd steps (G5), not the SDK or e2e ones", () => {
    const ids = beyondAlways([
      "packages/docs/src/content/docs/start/concepts.md",
    ]);
    expect(ids).toEqual([
      "docs-build",
      "admin-build",
      "assemble",
      "check-links",
      "workerd-typecheck",
      "workerd-test",
    ]);
    for (const x of ["python", "swift", "godot", "admin-e2e"])
      expect(ids).not.toContain(x);
  });
  it("a Python change runs python and lint-python only beyond the always steps", () => {
    expect(beyondAlways(["sdks/python/x.py"])).toEqual([
      "python",
      "lint-python",
    ]);
  });
  it("a shared input runs every lane step, format excepted", () => {
    const all = STEPS.map((s) => s.id).filter((id) => id !== "format");
    expect(ran(["tools/x.ts"])).toEqual(all);
    expect(ran(["conformance/corpus/v2/cases.json"])).toEqual(all);
  });
  it("unknown changes (null) run every lane step", () => {
    expect(ran(null)).toEqual(
      STEPS.map((s) => s.id).filter((i) => i !== "format"),
    );
  });
  it("--full runs every step, format included", () => {
    expect(ran(["docs/RUNBOOK.md"], { full: true })).toEqual(
      STEPS.map((s) => s.id),
    );
  });
  it("a skipped step keeps its number and says why", () => {
    const skipped = plan(["docs/a.md"]).steps.find((s) => s.id === "python");
    expect(skipped).toMatchObject({ n: 13, run: false });
    expect(skipped?.reason).toMatch(/python lane/);
  });
  it("--only and --from select by number", () => {
    expect(ran(null, { only: [3, 6] })).toEqual(["docs-build", "test"]);
    expect(ran(["docs/a.md"], { from: 10 })).toEqual([
      "check-links",
      "lint-ts",
      "skills",
    ]);
  });
  it("names the lanes CI runs that have no local step", () => {
    const { lanes } = plan(["packages/sdk-react/x.ts"]);
    expect(ciAlsoRuns(lanes)).toEqual(
      expect.arrayContaining(["browser", "node-floor", "react-kit"]),
    );
    expect(ciAlsoRuns(lanes)).not.toContain("workerd");
  });
});

describe("parseFlags", () => {
  it("reads ids and numbers", () => {
    expect(parseFlags(["--only", "3,test", "--from", "5"])).toMatchObject({
      only: [3, 6],
      from: 5,
      full: false,
    });
    expect(parseFlags(["--from", "lint"]).from).toBe(7);
  });
  it("reads --full, --plan, the base and a leading directory", () => {
    expect(parseFlags(["--full", "--dry-run"])).toMatchObject({
      full: true,
      plan: true,
    });
    expect(parseFlags(["/x", "--base", "integ/y"])).toMatchObject({
      dir: "/x",
      base: "integ/y",
    });
    expect(parseFlags([], { PKEY_GATE_BASE: "b" }).base).toBe("b");
  });
  it("refuses an unknown flag or step", () => {
    expect(() => parseFlags(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseFlags(["--only", "99"])).toThrow(/unknown step/);
    expect(() => parseFlags(["--only"])).toThrow(/needs a value/);
  });
});

const ctx: GateContext = {
  root: "/r",
  mergeBase: "abc123",
  files: ["a.md"],
  existing: ["a.md"],
  full: false,
};
const fake = (results: number[]) => {
  const log: string[] = [];
  const calls: string[][] = [];
  const events: string[] = [];
  const io: GateIo = {
    log: (l) => log.push(l),
    run: (argv) => {
      calls.push(argv);
      const status = results.shift() ?? 0;
      return { status, output: status ? "FAIL boom\n✓ fine\n" : "" };
    },
    acquire: () => events.push("acquire"),
    release: () => events.push("release"),
  };
  return { io, log, calls, events };
};
const only = (id: string) =>
  plan(null, { only: [STEPS.find((s) => s.id === id)!.n] }).steps;

describe("runSteps", () => {
  it("fail then pass passes on the retry", () => {
    const f = fake([1, 0]);
    expect(runSteps(only("typecheck"), ctx, f.io)).toBe(0);
    expect(f.calls).toHaveLength(2);
    expect(f.log.join("\n")).toMatch(/passed on retry/);
    expect(f.log.join("\n")).toContain("FAIL boom");
    expect(f.log.join("\n")).not.toContain("✓ fine");
  });
  it("fail twice exits 1 with the rerun lines", () => {
    const f = fake([1, 1]);
    expect(runSteps(only("typecheck"), ctx, f.io)).toBe(1);
    const out = f.log.join("\n");
    expect(out).toContain("pnpm gate --only 5");
    expect(out).toContain("pnpm gate --from 5");
  });
  it("stops at the first failing step", () => {
    const f = fake([1, 1]);
    const steps = plan(null, { only: [5, 6] }).steps;
    expect(runSteps(steps, ctx, f.io)).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
  it("takes the slot at the test step and gives it back", () => {
    const f = fake([]);
    expect(runSteps(plan(null, { only: [5, 6, 7] }).steps, ctx, f.io)).toBe(0);
    expect(f.events).toEqual(["acquire", "release"]);
    const g = fake([]);
    runSteps(only("typecheck"), ctx, g.io);
    expect(g.events).toEqual([]);
  });
});

describe("commandFor", () => {
  const step = (id: string) => STEPS.find((s) => s.id === id)!;
  it("applies the heavy prefix to heavy steps only", () => {
    const env = { PKEY_GATE_HEAVY: "/h/heavy.sh" };
    expect(commandFor(step("godot"), ctx, env)?.slice(0, 2)).toEqual([
      "/h/heavy.sh",
      "sdks/godot/tools/run_tests.sh",
    ]);
    expect(commandFor(step("admin-e2e"), ctx, env)?.[0]).toBe("/h/heavy.sh");
    expect(commandFor(step("typecheck"), ctx, env)?.[0]).toBe("pnpm");
    expect(commandFor(step("godot"), ctx, {})?.[0]).toBe(
      "sdks/godot/tools/run_tests.sh",
    );
  });
  it("narrows by the merge base when scoped and not when full", () => {
    expect(commandFor(step("typecheck"), ctx)).toContain(
      "--filter=...[abc123]",
    );
    expect(commandFor(step("gen"), ctx)).toEqual([
      "pnpm",
      "gen",
      "--changed",
      "--check",
      "--base",
      "abc123",
    ]);
    const full = { ...ctx, full: true };
    expect(commandFor(step("typecheck"), full)).not.toContain(
      "--filter=...[abc123]",
    );
    expect(commandFor(step("gen"), full)).toEqual(["pnpm", "gen", "--check"]);
    expect(commandFor(step("lint"), ctx)).toEqual([
      "pnpm",
      "exec",
      "prettier",
      "--check",
      "--ignore-unknown",
      "a.md",
    ]);
    expect(commandFor(step("lint"), full)).toEqual(["pnpm", "lint"]);
  });
  it("falls back to unfiltered commands when the changes are unknown", () => {
    const u = { ...ctx, mergeBase: null, files: null, existing: [] };
    expect(commandFor(step("typecheck"), u)).not.toContain(
      "--filter=...[abc123]",
    );
    expect(commandFor(step("gen"), u)).toEqual(["pnpm", "gen", "--check"]);
    expect(commandFor(step("lint"), u)).toEqual(["pnpm", "lint"]);
  });
});
