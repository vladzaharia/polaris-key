import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHROME } from "../src/boards.ts";
import { BOARDS, REPO_ROOT } from "../src/config.ts";
import { collect } from "../src/report.ts";
import { RULE_IDS, RULES } from "../src/rules.ts";

describe("the rule set and the board config", () => {
  it("every in-page rule id appears in the lint, and every allowance names a real rule", () => {
    const js = readFileSync(
      resolve(REPO_ROOT, "packages/ui-qa/src/browser/lint.js"),
      "utf8",
    );
    for (const r of RULES.filter(
      (x) => !["catalog-string", "kit-source"].includes(x.id),
    ))
      expect(js, r.id).toContain(`"${r.id}"`);
    for (const [board, marks] of Object.entries(CHROME)) {
      expect(BOARDS.map((b) => b.name)).toContain(board);
      for (const rule of Object.keys(marks.allow ?? {}))
        expect(RULE_IDS.has(rule), `${board}: ${rule}`).toBe(true);
    }
  });

  it("the report finds every board's shots and groups them by state", () => {
    const r = collect(REPO_ROOT);
    for (const b of BOARDS) expect(r.sources).toContain(`mockup:${b.name}`);
    expect(r.states).toContain("device-limit");
    const dl = r.shots
      .filter((s) => s.state === "device-limit")
      .map((s) => s.source);
    expect(new Set(dl).size).toBeGreaterThan(3);
  });
});
