// The worker suite runs most files in one shared module graph (vitest.isolation.ts). These checks
// keep that safe: a file that replaces a module runs in the isolated project, and production code
// never calls the test-only reset.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GRAPH_APIS, isolatedFiles, testFiles } from "../vitest.isolation.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".test.ts"))
      out.push(p);
  }
  return out;
}

describe("shared module graph", () => {
  it("puts every file that calls a module-graph API in the isolated project", () => {
    const isolated = new Set(isolatedFiles(root));
    const shared = testFiles(root).filter((f) => !isolated.has(f));
    expect(isolated.size).toBeGreaterThan(0);
    const leaks = shared.filter((f) =>
      GRAPH_APIS.test(readFileSync(join(root, f), "utf8")),
    );
    expect(leaks).toEqual([]);
  });

  it("matches module-graph calls however they are spaced", () => {
    for (const call of [
      "vi.mock(",
      "vi . doMock (",
      "vi.resetModules(",
      "vi\n.unmock(",
    ])
      expect(GRAPH_APIS.test(call)).toBe(true);
    expect(GRAPH_APIS.test("vi.fn(")).toBe(false);
  });

  it("lists each test file once", () => {
    const all = testFiles(root);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps runResets out of production code", () => {
    const callers = sources(join(root, "src"))
      .filter((p) => !p.endsWith(join("platform", "testReset.ts")))
      .filter((p) => /\brunResets\b/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(root.length + 1));
    expect(callers).toEqual([]);
  });
});
