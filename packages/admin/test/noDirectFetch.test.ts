/**
 * `fetch` is called in one module: `lib/http.ts`. Every request goes through its client, so the
 * CSRF header, the refusal parser and the network-failure rule exist once (P0-32).
 *
 * The scan is on the AST, so `window.fetch(...)`, `globalThis["fetch"](...)` and line breaks cannot
 * hide a call. `KNOWN` lists the files that still call it, each with the slice that removes it. The
 * list only shrinks: a new call fails the suite, and so does a listed file with no call left.
 */

import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ALLOWED = "lib/http.ts";

/** Files that still call `fetch`, as paths under `src/`, each with the slice that removes it. */
const KNOWN: Record<string, string> = {
  "api.ts": "P0-32.10",
};

const GLOBALS = new Set(["window", "globalThis", "self"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Line numbers of every call to `fetch`, `window.fetch`, `globalThis.fetch` (or `["fetch"]`). */
function fetchCalls(text: string): number[] {
  const sf = ts.createSourceFile("f.tsx", text, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const isGlobal = (n: ts.Expression): boolean =>
    ts.isIdentifier(n) && GLOBALS.has(n.text);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const hit =
        (ts.isIdentifier(callee) && callee.text === "fetch") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "fetch" &&
          isGlobal(callee.expression)) ||
        (ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression) &&
          callee.argumentExpression.text === "fetch" &&
          isGlobal(callee.expression));
      if (hit)
        lines.push(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

function callsByFile(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const file of sources(SRC)) {
    const lines = fetchCalls(readFileSync(file, "utf8"));
    if (lines.length) found.set(relative(SRC, file), lines);
  }
  return found;
}

describe("no direct fetch", () => {
  const found = callsByFile();

  it("fetch is called only in lib/http.ts, bar the listed files", () => {
    const offenders = [...found]
      .filter(([file]) => file !== ALLOWED && !(file in KNOWN))
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(offenders, "send the request through lib/http.ts").toEqual([]);
  });

  it("every listed file still calls fetch (delete its entry when it stops)", () => {
    const stale = Object.keys(KNOWN).filter((file) => !found.has(file));
    expect(stale).toEqual([]);
  });

  it("the check catches the shapes a regex would miss", () => {
    const hits = (code: string) => fetchCalls(code).length;
    expect(hits('await fetch("/x");')).toBe(1);
    expect(hits('await window.fetch("/x");')).toBe(1);
    expect(hits('await globalThis\n  .fetch("/x");')).toBe(1);
    expect(hits('await globalThis["fetch"]("/x");')).toBe(1);
    // Not a call to the global.
    expect(
      hits('const fetchUser = () => 1; fetchUser(); api.fetch("/x");'),
    ).toBe(0);
    expect(hits("// fetch(1)\nconst s = 'fetch(2)';")).toBe(0);
  });

  it("a new call in a file outside the list fails the scan", () => {
    const probe = join(SRC, "lib", "__fetchProbe__.ts");
    writeFileSync(probe, 'export const x = () => fetch("/x");\n');
    try {
      const probed = callsByFile();
      expect(probed.has("lib/__fetchProbe__.ts")).toBe(true);
      expect("lib/__fetchProbe__.ts" in KNOWN).toBe(false);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
