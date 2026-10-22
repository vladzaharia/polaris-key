import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// B-206: a mocked route handler still in flight when its context closes throws
// "route.fetch: Request context disposed". Every e2e file that routes closes
// through closeContext (e2e/teardown.ts) or through portalHarness, which does.
describe("e2e route hygiene", () => {
  it("every e2e file that calls .route( closes through the shared teardown", () => {
    const dir = join(__dirname, "..", "e2e");
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "teardown.ts")
      .filter((f) => {
        const src = readFileSync(join(dir, f), "utf8");
        if (!/\.route\(/.test(src)) return false;
        if (f === "portalHarness.ts") return !/closeContext\(/.test(src);
        return !/closeContext\(|from "\.\/portalHarness(?:\.js)?"/.test(src);
      });
    expect(bad).toEqual([]);
  });

  it("no e2e file closes a context without unrouting first", () => {
    const dir = join(__dirname, "..", "e2e");
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "teardown.ts")
      .filter((f) =>
        /(?:\.context\(\)|\b(?:ctx|context))\.close\(\)/.test(
          readFileSync(join(dir, f), "utf8"),
        ),
      );
    expect(bad).toEqual([]);
  });
});
