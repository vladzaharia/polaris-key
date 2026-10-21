/**
 * Console help links live in exactly two tables (`console/nav.ts` and `lib/docsLinks.ts`), gated
 * against the built slug manifest. A `/docs/admin/*` literal anywhere else is a path the docs
 * site only redirects, and it bypasses that gate.
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

describe("console docs links", () => {
  it("names no legacy /docs/admin/ path anywhere in src", () => {
    const hits = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => readFileSync(f, "utf8").includes("/docs/admin/"))
      .map((f) => f.slice(SRC.length + 1));
    expect(hits).toEqual([]);
  });
});
