import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * One cache entry, one shape. TanStack Query keeps a single value per key, and the first observer
 * to fetch decides what that value is. Two readers of the same key that fetch different things
 * (the raw `{ products }` response in one, the bare array in the other) break each other in
 * whichever order they load: that was the blank Products page and the crashing switcher.
 *
 * So this scans every `useResource(qk.X(…), fetcher)` and `useQuery({ queryKey: qk.X(…), queryFn })`
 * in `src/` and requires every reader of one key family to pass the same fetcher (compared as
 * source text, give or take whitespace, `async` and non-null `!`). Sharing a named fetcher such as
 * `fetchProducts` or `fetchProduct` is the way to satisfy it.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".d.ts") ? [path] : [];
  });
}

interface Reader {
  family: string;
  fetcher: string;
  at: string;
}

/** `qk.X(…)` → `X`; anything else → null. */
function familyOf(expr: ts.Expression): string | null {
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "qk"
  ) {
    return expr.expression.name.text;
  }
  return null;
}

/** Resolve a key expression: a `qk.X(…)` call, or a `const` in the same file initialised with one. */
function resolveFamily(
  expr: ts.Expression,
  file: ts.SourceFile,
): string | null {
  const direct = familyOf(expr);
  if (direct || !ts.isIdentifier(expr)) return direct;
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === expr.text &&
      node.initializer
    ) {
      found = familyOf(node.initializer) ?? found;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const normalize = (text: string): string =>
  text
    .replace(/\basync\s+/g, "")
    .replace(/!(?=[),.\s])/g, "")
    .replace(/\s+/g, "");

/** `useResource`'s own `useQuery({ queryKey: key, queryFn: fetcher })`: generic by design. */
const GENERIC = new Set(["context.tsx"]);

function scan(): { readers: Reader[]; unresolved: string[] } {
  const readers: Reader[] = [];
  const unresolved: string[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    if (!/useResource\(|useQuery\(/.test(text)) continue;
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const rel = relative(SRC, path);
    const record = (
      key: ts.Expression,
      fetcher: ts.Expression,
      node: ts.Node,
    ): void => {
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const at = `${rel}:${line}`;
      const family = resolveFamily(key, file);
      if (!family) {
        if (!GENERIC.has(rel)) unresolved.push(`${at} ${key.getText()}`);
        return;
      }
      readers.push({ family, fetcher: normalize(fetcher.getText()), at });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = node.expression.text;
        if (callee === "useResource" && node.arguments.length >= 2) {
          record(node.arguments[0]!, node.arguments[1]!, node);
        } else if (callee === "useQuery") {
          const opts = node.arguments[0];
          if (opts && ts.isObjectLiteralExpression(opts)) {
            const prop = (name: string): ts.Expression | undefined => {
              const p = opts.properties.find(
                (q) =>
                  q.name && ts.isIdentifier(q.name) && q.name.text === name,
              );
              return p && ts.isPropertyAssignment(p)
                ? p.initializer
                : undefined;
            };
            const key = prop("queryKey");
            const fn = prop("queryFn");
            if (key && fn) record(key, fn, node);
            else
              unresolved.push(`${rel}: useQuery without queryKey and queryFn`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { readers, unresolved };
}

describe("query keys hold one shape (the qk.products() regression)", () => {
  const { readers, unresolved } = scan();

  it("finds the readers it is meant to police", () => {
    const families = new Set(readers.map((r) => r.family));
    for (const f of ["products", "product", "me", "tiers", "services"]) {
      expect(
        families,
        `no reader of qk.${f} found: is the scan broken?`,
      ).toContain(f);
    }
    // The registry list has exactly one reader: the shell's `useProducts`. Home, Products and the
    // switcher all call that hook, so no page can cache another shape under the key (chunk 4
    // replaced the Products page's own reader with the hook).
    expect(
      readers
        .filter((r) => r.family === "products")
        .map((r) => r.at.split(":")[0]),
    ).toEqual(["console/data/hooks.ts"]);
  });

  it("every key is a qk.X(…) call, directly or through a const", () => {
    expect(unresolved).toEqual([]);
  });

  it("every reader of one key family passes the same fetcher", () => {
    const byFamily = new Map<string, Reader[]>();
    for (const r of readers) {
      byFamily.set(r.family, [...(byFamily.get(r.family) ?? []), r]);
    }
    const conflicts: string[] = [];
    for (const [family, list] of byFamily) {
      const fetchers = new Set(list.map((r) => r.fetcher));
      if (fetchers.size > 1) {
        conflicts.push(
          `qk.${family}: ${list.map((r) => `${r.at} ${r.fetcher}`).join(" | ")}`,
        );
      }
    }
    expect(conflicts).toEqual([]);
  });
});
