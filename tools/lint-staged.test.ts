/**
 * tools/lint-staged.mjs (the pre-commit lint of the staged files) and the `--only` mode of the
 * ledger tool it relies on.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lanesFor, SDKS } from "./lint-staged.mjs";
import { run } from "./lint/lint-debt.mjs";

const dir = mkdtempSync(join(tmpdir(), "lint-staged-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("lint-staged lanes", () => {
  it("sends each staged file to the one SDK whose linter reads it", () => {
    const lanes = lanesFor([
      "README.md",
      "sdks/python/src/polaris_key/a.py",
      "sdks/kotlin/core/src/main/kotlin/A.kt",
      "sdks/godot/addons/polaris_key/a.gd",
      "sdks/godot/native/a.gd",
      "sdks/swift/Sources/PolarisKeyCore/A.swift",
      "sdks/swift/Sources/PolarisKeyCore/Resources/B.swift",
    ]);
    expect(lanes.map((l) => [l.id, l.files.length])).toEqual([
      ["python", 1],
      ["kotlin", 1],
      ["godot", 1],
      ["swift", 2],
    ]);
  });

  it("runs no SDK linter for a docs-only change", () => {
    expect(lanesFor(["packages/docs/a.mdx", "tools/x.ts"])).toEqual([]);
    expect(SDKS.map((s) => s.id)).toEqual([
      "python",
      "kotlin",
      "godot",
      "swift",
    ]);
  });
});

describe("lint-debt --only", () => {
  const input = join(dir, "ruff.json");
  const ledger = join(dir, "ledger.json");
  const only = join(dir, "only.txt");
  const abs = (f: string) => join(process.cwd(), f);

  it("holds only the listed files to the ledger, and does not call the rest cleared", async () => {
    writeFileSync(
      input,
      JSON.stringify([
        { filename: abs("a.py"), code: "E501" },
        { filename: abs("a.py"), code: "E501" },
      ]),
    );
    writeFileSync(
      ledger,
      JSON.stringify({
        version: 1,
        debt: { "a.py": { "ruff:E501": 1 }, "b.py": { "ruff:E501": 3 } },
      }),
    );
    writeFileSync(only, "a.py\n");
    const args = [
      "check",
      "--tool",
      "ruff",
      "--ledger",
      ledger,
      "--input",
      input,
      "--root",
      process.cwd(),
    ];
    // a.py has 2 findings against 1 in the ledger: new. b.py is not listed: not cleared.
    const r = await run([...args, "--only", only]);
    expect(r.code).toBe(1);
    expect(r.out.join("\n")).toContain("new: a.py ruff:E501 2 (ledger 1)");
    expect(r.out.join("\n")).not.toContain("b.py");
    // The whole-tree run sees b.py as cleared too.
    const whole = await run(args);
    expect(whole.out.join("\n")).toContain("cleared (re-record): b.py");
  });
});
