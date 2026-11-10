/**
 * Non-masking steps (.github/workflows/ci.yml): a failed check must not hide the next one, so one run
 * reports every failure instead of one per cycle. The `js` job runs every check after `pnpm build` under
 * `!cancelled() && steps.build.outcome == 'success'`. The four SDK jobs lint with `continue-on-error`
 * and end in a step that fails the job when the lint did, so the tests after the lint still run.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
  uses?: string;
  "continue-on-error"?: boolean;
};
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const ci = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as Workflow;

const steps = (job: string): Step[] => {
  const j = ci.jobs[job];
  if (!j) throw new Error(`ci.yml has no job ${job}`);
  return j.steps;
};

// A step that already runs whatever happened (a stop or an upload) is not a check.
const alwaysRuns = (s: Step): boolean =>
  /\balways\(\)|\bfailure\(\)/.test(s.if ?? "");

describe("js job: every check after the build runs", () => {
  const js = steps("js");
  const at = js.findIndex((s) => s.id === "build");

  it("has a build step with an id", () => {
    expect(at).toBeGreaterThan(-1);
    expect(js[at]!.run).toBe("pnpm build");
  });

  it("gives every later step the build-succeeded condition", () => {
    const later = js.slice(at + 1);
    expect(later.length).toBeGreaterThan(8);
    for (const s of later) {
      expect(s.if, s.name ?? s.run).toContain("!cancelled()");
      expect(s.if, s.name ?? s.run).toContain(
        "steps.build.outcome == 'success'",
      );
    }
  });
});

describe("SDK jobs: a failed lint does not skip the tests", () => {
  for (const job of ["python", "kotlin", "apple", "godot"]) {
    describe(job, () => {
      const list = steps(job);
      const lint = list.findIndex((s) => s.id === "lint");

      it("has a lint step that does not stop the job", () => {
        expect(lint).toBeGreaterThan(-1);
        expect(list[lint]!["continue-on-error"]).toBe(true);
      });

      it("fails the job at the end when the lint failed", () => {
        const last = list.findLastIndex((s) =>
          (s.name ?? "").startsWith("Fail the job when lint failed"),
        );
        expect(last).toBeGreaterThan(lint);
        const fail = list[last]!;
        expect(fail.if).toContain("!cancelled()");
        expect(fail.if).toContain("steps.lint.outcome == 'failure'");
        expect(fail.run).toContain("exit 1");
        // Only always-run steps (stop, upload) and non-check steps may follow it.
        for (const s of list.slice(last + 1)) expect(alwaysRuns(s)).toBe(true);
      });

      it("has no step between the lint and the failing step that is skipped by it", () => {
        // continue-on-error keeps the job's status success, so a later step without an `if` runs.
        for (const s of list.slice(lint + 1))
          expect(s.if ?? "", s.name ?? s.run).not.toMatch(
            /steps\.lint\.outcome\s*==\s*'success'/,
          );
      });
    });
  }
});

describe("test steps report their cost (tools/ci-measure.sh)", () => {
  const MEASURE = /(?:tools|\$GITHUB_WORKSPACE\/tools)\/ci-measure\.sh/;
  const measured = Object.entries(ci.jobs).flatMap(([job, j]) =>
    j.steps
      .filter((s) => MEASURE.test(s.run ?? ""))
      .map((s) => ({ job, step: s })),
  );

  it("wraps the main test step of every JS lane, Python, Swift, Kotlin, Android and Godot", () => {
    const jobs = new Set(measured.map((m) => m.job));
    for (const job of [
      "js-worker",
      "js-admin",
      "js-rest",
      "workerd",
      "react-kit",
      "python",
      "apple",
      "kotlin",
      "kotlin-desktop",
      "android",
      "godot",
    ])
      expect(jobs.has(job), job).toBe(true);
  });

  it("gives every measured command a label and keeps the command it measures", () => {
    for (const { job, step } of measured)
      for (const line of (step.run ?? "").split("\n"))
        if (MEASURE.test(line))
          expect(line, `${job}: ${line}`).toMatch(
            /ci-measure\.sh"? "[^"]+" \S+/,
          );
  });

  it("measures only where bash runs the step", () => {
    // The Windows desktop leg runs its own step, which stays unmeasured.
    for (const { job, step } of measured)
      expect(step.if ?? "", `${job}/${step.name}`).not.toContain("Windows");
  });
});
