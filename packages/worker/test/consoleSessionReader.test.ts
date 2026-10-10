/**
 * One reader of the console session (ST-29; ST-28 plan §2.7, security checklist item 2). Only the
 * deny-by-default dispatcher (`console/api.ts`, `resolveConsoleCaller`) turns the session cookie
 * into a caller; the docs gate goes through the same resolver. A second reader would be a route
 * that authorizes on its own, beside the route table instead of through it.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory()
      ? walk(full)
      : name.endsWith(".ts")
        ? [full]
        : [];
  });
}

/** Files that call `name(` outside comments, with the number of calls. */
function callers(name: string): Record<string, number> {
  const out: Record<string, number> = {};
  const call = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const file of walk(SRC)) {
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const n = (code.match(call) ?? []).length;
    if (n) out[relative(SRC, file)] = n;
  }
  return out;
}

describe("the console session reader", () => {
  it("sessionFromRequest() is called by the dispatcher alone (and defined in core/console/session.ts)", () => {
    expect(callers("sessionFromRequest")).toEqual({
      "console/api.ts": 1,
      // The definition.
      "core/console/session.ts": 1,
    });
  });

  it("verifySession() is reached only through sessionFromRequest()", () => {
    expect(callers("verifySession")).toEqual({
      "core/console/session.ts": 2,
    });
  });

  it("the docs gate asks the dispatcher's resolver, not the cookie", () => {
    const docs = readFileSync(join(SRC, "docs.ts"), "utf8");
    expect(docs).toMatch(/resolveConsoleCaller\(/);
    expect(docs).not.toMatch(/core\/console\/session/);
  });
});
