/**
 * The console's copy uses the straight apostrophe (the style guide and every other string do):
 * "You don't have access" and the 403's "You don't" read alike. A curly one in a string is a
 * mismatch that `getByText` assertions then pin by accident.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("console copy", () => {
  it("has no curly apostrophe in the console, the UI kit or the service table", () => {
    const hits = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /\/(console|ui|kit)\/|services\.generated\.ts$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("’"))
      .map((f) => f.slice(SRC.length + 1));
    expect(hits).toEqual([]);
  });
});
