// `src/platform/testReset.ts`: modules register how to empty their isolate-level caches, and the
// test setup runs them between tests. Production must never run them.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { registerReset, runResets } from "../../src/platform/testReset.js";

const SRC = join(__dirname, "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("test reset registry", () => {
  it("runs every registered reset", () => {
    let calls = 0;
    registerReset(() => {
      calls += 1;
    });
    runResets();
    expect(calls).toBe(1);
  });

  it("is run by no production module", () => {
    const callers = sources(SRC)
      .filter((p) => !p.endsWith(join("platform", "testReset.ts")))
      .filter((p) => /\brunResets\b/.test(readFileSync(p, "utf8")))
      .map((p) => relative(SRC, p));
    expect(callers).toEqual([]);
  });
});
