import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PX-29: a return link in the portal is followed only through `allowedReturn` (the product's
 * declared targets) or `cardReturn` (the login card). A `return` query value reaching an `href`
 * or a navigation any other way fails here.
 */
const ROOT = join(__dirname, "../src/portal");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("portal return links", () => {
  it("reads the return query only into the validators", () => {
    for (const f of files(ROOT)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/get\(\s*["']return["']\s*\)/g)) {
        const around = src.slice(Math.max(0, m.index! - 40), m.index! + 80);
        const ok =
          f.endsWith("router.ts") ||
          /allowedReturn\(\s*params\.get/.test(around);
        expect(ok, `${f}: ${around}`).toBe(true);
      }
    }
  });

  it("never sets an href from a raw return value", () => {
    for (const f of files(ROOT)) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(
        /href=\{\s*(appReturn|returnTo|returnParam)\s*\}/,
      );
    }
  });
});
