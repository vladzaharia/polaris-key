/**
 * The Worker's source writes no `console.*`: an operator-visible failure is an audit row or an
 * ops signal. The operator console's own sources under `src/console/` are named for the console
 * surface, not the global, and are checked for the global call the same way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

describe("worker source", () => {
  it("has no console.* call", () => {
    const hits = files(SRC).filter((f) =>
      /(^|[^\w.])console\.(log|info|warn|error|debug|trace)\s*\(/m.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(hits).toEqual([]);
  });
});
