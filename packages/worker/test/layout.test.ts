/**
 * The worker test layout (P0-30.5; plans/P0-30-AX-07-slices.md D-P5). Every `*.test.ts` directly
 * under `test/` is a named guard (`GUARDS` in `scripts/test-layout.mjs`); every other one lives
 * under `core/`, `services/<slug>/` (slug from `tools/services.json`), `surfaces/` or an
 * existing subdirectory.
 *
 * Blocking since P0-30.6: a flat test that is not a guard, or a services/<slug> that is not in
 * tools/services.json, fails the suite.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARDS, serviceSlugs } from "../scripts/test-layout.mjs";
import { TEST_ROOT } from "./paths.js";

const REPO = join(TEST_ROOT, "..", "..", "..");

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    if (e.isDirectory()) out.push(...testFiles(join(dir, e.name)));
    else if (e.name.endsWith(".test.ts")) out.push(join(dir, e.name));
  }
  return out;
}

describe("worker test layout", () => {
  it("every flat test is a guard, every other sits in the layout", () => {
    const slugs = serviceSlugs(REPO);
    const problems: string[] = [];
    for (const abs of testFiles(TEST_ROOT)) {
      const rel = abs.slice(TEST_ROOT.length + 1);
      const parts = rel.split("/");
      if (parts.length === 1) {
        if (!Object.hasOwn(GUARDS, rel.replace(/\.test\.ts$/, "")))
          problems.push(`${rel}: flat test that is not a guard`);
      } else if (parts[0] === "services") {
        if (!slugs.includes(parts[1] ?? ""))
          problems.push(
            `${rel}: services/<slug> must be one of ${slugs.join(", ")}`,
          );
      }
    }
    expect(problems).toEqual([]);
  });

  it("every guard names a reason", () => {
    for (const [name, why] of Object.entries(GUARDS)) {
      expect(why.length, name).toBeGreaterThan(10);
    }
  });
});
