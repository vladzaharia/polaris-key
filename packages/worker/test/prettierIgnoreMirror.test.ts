// Prettier reads only the .prettierignore of the directory it runs in, so the worker's file shadows
// the root one. Every root entry under packages/worker/ must appear in it (relative), or the
// package's lint and its editor reformat the byte-compared goldens (B-203; it happened twice).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const entries = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

describe("the worker's .prettierignore", () => {
  it("repeats every root entry under packages/worker/", () => {
    const root = entries(join(import.meta.dirname, "../../../.prettierignore"));
    const own = new Set(
      entries(join(import.meta.dirname, "../.prettierignore")),
    );
    const expected = root
      .filter((l) => l.startsWith("packages/worker/"))
      .map((l) => l.slice("packages/worker/".length));
    expect(expected.length).toBeGreaterThan(0);
    for (const e of expected) expect(own.has(e), e).toBe(true);
  });
});
