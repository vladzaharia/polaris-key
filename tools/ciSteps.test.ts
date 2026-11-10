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
