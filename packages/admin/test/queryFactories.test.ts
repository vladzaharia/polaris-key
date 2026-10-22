/**
 * Reads are spelled once. In the portal (the console joins later in P0-32) `portal/queries.ts` is
 * the only file with a `queryFn`, and the only one that builds a `queryKey` array: one `qk` entry
 * and one `pq` factory per key family. A hook calls `useQuery(pq.x(...))`, a write invalidates
 * with `queryKey: qk.x(...)`.
 *
 * The scan is on the AST, so line breaks and aliases cannot hide a literal.
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
const PORTAL = join(SRC, "portal");
const QUERIES = join(PORTAL, "queries.ts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const parse = (text: string) =>
  ts.createSourceFile("f.tsx", text, ts.ScriptTarget.Latest, true);

/** Is `node` a call `qk.name(...)` (or `qkFamily(...)`, a prefix)? */
function qkCall(node: ts.Expression): string | null {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "qkFamily"
  )
    return "qkFamily";
  return ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "qk"
    ? node.expression.name.text
    : null;
}

/** Spots outside queries.ts that spell a `queryFn`, or a `queryKey` that is not a `qk.x(...)` call. */
function offences(text: string): string[] {
  const sf = parse(text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) ||
      ts.isShorthandPropertyAssignment(node)
    ) {
      const name = node.name.getText(sf);
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      if (name === "queryFn") found.push(`${line} queryFn`);
      if (name === "queryKey") {
        const ok =
          ts.isPropertyAssignment(node) && qkCall(node.initializer) !== null;
        if (!ok) found.push(`${line} queryKey is not qk.x(...)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("portal reads are factories", () => {
  it("no queryFn, and no queryKey literal, outside portal/queries.ts", () => {
    const offenders = sources(PORTAL)
      .filter((f) => f !== QUERIES)
      .flatMap((f) =>
        offences(readFileSync(f, "utf8")).map(
          (o) => `${relative(SRC, f)}:${o}`,
        ),
      );
    expect(offenders, "add a factory to portal/queries.ts").toEqual([]);
  });

  it("every qk family has exactly one pq factory, and every factory uses its own family", () => {
    const sf = parse(readFileSync(QUERIES, "utf8"));
    const qkNames: string[] = [];
    const factoryKeys: Record<string, string[]> = {};
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectLiteralExpression(node.initializer ?? node)
      ) {
        const obj = node.initializer as ts.ObjectLiteralExpression;
        const id = node.name.getText(sf);
        if (id === "qk")
          for (const p of obj.properties) qkNames.push(p.name!.getText(sf));
        if (id === "pq")
          for (const p of obj.properties) {
            const used: string[] = [];
            const scan = (n: ts.Node): void => {
              if (
                ts.isPropertyAssignment(n) &&
                n.name.getText(sf) === "queryKey"
              ) {
                const name = qkCall(n.initializer);
                if (name) used.push(name);
              }
              ts.forEachChild(n, scan);
            };
            scan(p);
            factoryKeys[p.name!.getText(sf)] = used;
          }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(qkNames.length).toBeGreaterThan(0);
    // Each factory owns exactly one key family, and no two share one.
    for (const [factory, used] of Object.entries(factoryKeys))
      expect(used, `pq.${factory}`).toHaveLength(1);
    const owned = Object.values(factoryKeys).flat();
    expect(new Set(owned).size, "two factories share a family").toBe(
      owned.length,
    );
    expect([...owned].sort(), "a qk family without a factory").toEqual(
      [...qkNames].sort(),
    );
  });

  it("the scan catches the shapes that would slip a regex", () => {
    expect(
      offences("useQuery({ queryKey: ['portal','x'], queryFn: f });"),
    ).toHaveLength(2);
    expect(offences("const o = {\n  queryFn\n};")).toHaveLength(1);
    expect(offences("qc.invalidateQueries({ queryKey: key });")).toHaveLength(
      1,
    );
    expect(offences("qc.invalidateQueries({ queryKey: qk.me() });")).toEqual(
      [],
    );
    expect(offences("useQuery(pq.me());")).toEqual([]);
  });

  it("a stray literal in a portal file fails the scan", () => {
    const probe = join(PORTAL, "__queryProbe__.ts");
    writeFileSync(probe, 'export const q = { queryKey: ["portal", "x"] };\n');
    try {
      const stray = sources(PORTAL)
        .filter((f) => f !== QUERIES)
        .flatMap((f) =>
          offences(readFileSync(f, "utf8")).map(() => relative(SRC, f)),
        );
      expect(stray).toContain("portal/__queryProbe__.ts");
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
