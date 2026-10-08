/**
 * P0-48: the written gate lists agree with CI. AGENTS.md, CONTRIBUTING.md and the docs site's
 * contributor setup page each say their green gate is "what CI runs"; this keeps that true for
 * the drift gates. Every `… -- --check` command the required `js` job of
 * `.github/workflows/ci.yml` runs must appear, verbatim, in each list. (The lead's own gate
 * script lives outside the repository, so it cannot be checked here.)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

interface Workflow {
  jobs: Record<string, { steps?: { run?: string }[] }>;
}

/** The drift-gate commands CI's `js` job runs, as written there. */
function ciDriftGates(): string[] {
  const ci = parseYaml(read(".github", "workflows", "ci.yml")) as Workflow;
  return (ci.jobs.js?.steps ?? [])
    .map((s) => s.run?.trim() ?? "")
    .filter((run) => /^pnpm .*-- --check$/.test(run));
}

const LISTS: [string, string][] = [
  ["AGENTS.md", read("AGENTS.md")],
  ["CONTRIBUTING.md", read("CONTRIBUTING.md")],
  [
    "packages/docs/src/content/docs/contribute/setup.md",
    read("packages", "docs", "src", "content", "docs", "contribute", "setup.md"),
  ],
];

describe("the green-gate lists name every drift gate CI runs", () => {
  const gates = ciDriftGates();

  it("finds CI's drift gates", () => {
    // A rename of the job or a reshaped step would otherwise leave nothing to compare.
    expect(gates).toContain("pnpm gen:corpus -- --check");
    expect(gates).toContain("pnpm gen:settings -- --check");
  });

  for (const [file, text] of LISTS)
    it(`${file} lists each of them`, () => {
      expect(gates.filter((g) => !text.includes(g))).toEqual([]);
    });
});
