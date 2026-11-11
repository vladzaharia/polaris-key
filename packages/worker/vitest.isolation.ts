// Which test files need a module graph of their own.
//
// The suite runs without per-file isolation (the `shared` project): files in one worker share a
// module graph, so a module is evaluated once per worker and not once per file. The Worker's
// isolate-level caches register a clear with `src/platform/testReset.ts`, which the setup runs at
// each file boundary (`test/setup/oidcClient.ts`).
//
// A file that replaces a module (`vi.mock`, `vi.doMock`) or empties the module cache
// (`vi.resetModules`) cannot share: a module another file already loaded keeps the real
// dependency. Those files form the `isolated` project, which keeps the runner's default of a fresh
// graph per file. The partition is derived from the source here, so a new mocking file lands in
// the right project by itself; `test/isolationGuard.test.ts` asserts it.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const TEST_INCLUDE = [
  "test/**/*.test.ts",
  "src/**/*.test.ts",
  "scripts/*.test.ts",
];

// The module-graph APIs a shared file may not call.
export const GRAPH_APIS =
  /\bvi\s*\.\s*(?:mock|doMock|unmock|doUnmock|resetModules)\s*\(/;

const ROOTS = ["test", "src", "scripts"];

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".test.ts")) out.push(p);
  }
}

/** Every test file the suite runs, relative to the package, sorted. */
export function testFiles(root: string): string[] {
  const all: string[] = [];
  for (const r of ROOTS) {
    try {
      walk(join(root, r), all);
    } catch {
      /* a root the package does not have */
    }
  }
  return all
    .map((p) => relative(root, p).split("\\").join("/"))
    .filter((p) => !(p.startsWith("scripts/") && p.split("/").length > 2))
    .sort();
}

/** The files that call a module-graph API. */
export function isolatedFiles(root: string): string[] {
  return testFiles(root).filter((f) =>
    GRAPH_APIS.test(readFileSync(join(root, f), "utf8")),
  );
}
