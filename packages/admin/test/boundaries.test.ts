/**
 * Layer boundaries inside the admin package (the console at `/manage`, the customer portal at `/`
 * and the kit they share), modelled on `packages/worker/test/boundaries.test.ts`.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────
 *
 *   1. `lib/` is pure and app-neutral: it imports only `lib/`.
 *   2. `ui/` is the shared React kit and app-neutral: it imports only `ui/`, `lib/` and the
 *      app-neutral root modules in `UI_MAY_IMPORT` (the generated service table and the theme).
 *   3. The two apps are isolated: nothing under `console/` imports `portal/`, and nothing under
 *      `portal/` imports `console/`.
 *   4. The customer bundle carries no console code: no module reachable from `portal/main.tsx`
 *      (static and dynamic imports; `import type` is erased and does not count) is under
 *      `console/` or is `api.ts`, the console's API client with every `/manage/api` path in it.
 *
 * Rules 1 and 2 count `import type` too: a type import still ties the kit to an app's shapes.
 *
 * ── KNOWN EDGES ─────────────────────────────────────────────────────────────────────────────
 *
 * The edges that break a rule today are listed in `KNOWN`, each with the work package that
 * removes it. The list only shrinks: a new edge fails the suite, and so does a listed edge that
 * no longer exists (delete its entry in the change that removes it).
 *
 * A test and not a lint rule for the same reason as the Worker's: `pnpm lint` is Prettier.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Root modules `ui/` may import: app-neutral, owned by neither app. */
const UI_MAY_IMPORT = new Set([
  // Generated from tools/services.json (pnpm gen:services): data, not app code.
  "services.generated.ts",
  // The light/dark/system theme both apps mount.
  "components/theme.tsx",
]);

/**
 * Edges that break a rule today, as `from -> to` (paths under `src/`), each with its owner. The
 * portal entry's reach into `api.ts` is listed as `portal/main.tsx -> api.ts`.
 */
const KNOWN: Record<string, string> = {
  // P0-32 (one data layer): errorCopy words HttpError, not the console's ApiError.
  "lib/errorCopy.ts -> api.ts": "P0-32",
  "ui/form.tsx -> api.ts": "P0-32",
  "portal/main.tsx -> api.ts":
    "P0-32 (through ui/toast.tsx -> lib/errorCopy.ts)",
  // P0-34 (shared router core): the guard blocks navigation through the core, not the console's.
  "ui/useUnsavedChangesGuard.tsx -> console/router.tsx": "P0-34",
  // P0-33 (Worker-owned DTO types): the shapes come from @polaris-key/worker/dto, not api.ts.
  "lib/products.ts -> api.ts": "P0-33",
  "lib/secretUsage.ts -> api.ts": "P0-33",
  "ui/EmptyState.tsx -> api.ts": "P0-33",
  "ui/ProductLogo.tsx -> api.ts": "P0-33",
  "ui/ServiceBadge.tsx -> api.ts": "P0-33",
};

interface Edge {
  from: string;
  to: string;
  /** `import type` (or every named binding type-only): erased from the bundle. */
  typeOnly: boolean;
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx)$/.test(entry)) yield full;
  }
}

/** A relative specifier (`../lib/cn.js`) to the source file it names, or null (a CSS file). */
function resolveLocal(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec).replace(/\.(js|jsx|ts|tsx)$/, "");
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ])
    if (existsSync(candidate)) return relative(SRC, candidate);
  return null;
}

/** Every local import edge in `src/`: import and export declarations, `import()` and `import("…")` types. */
function edges(): Edge[] {
  const out: Edge[] = [];
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const from = relative(SRC, path);
    const add = (spec: string, typeOnly: boolean): void => {
      if (!spec.startsWith(".")) return;
      const to = resolveLocal(path, spec);
      if (to) out.push({ from, to, typeOnly });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const typeOnly =
          !!clause &&
          (clause.isTypeOnly ||
            (!clause.name &&
              !!named &&
              ts.isNamedImports(named) &&
              named.elements.length > 0 &&
              named.elements.every((e) => e.isTypeOnly)));
        add((node.moduleSpecifier as ts.StringLiteral).text, typeOnly);
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        add(node.moduleSpecifier.text, node.isTypeOnly);
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        add(node.arguments[0].text, false);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        add(node.argument.literal.text, true);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return out;
}

const ALL = edges();
const top = (path: string): string => path.split("/")[0]!;

/** Rules 1 to 3: the edges that break a layer rule, as `from -> to`. */
function layerOffences(): string[] {
  const offences = new Set<string>();
  for (const { from, to } of ALL) {
    const a = top(from);
    const b = top(to);
    const ok =
      a === "lib"
        ? b === "lib"
        : a === "ui"
          ? b === "ui" || b === "lib" || UI_MAY_IMPORT.has(to)
          : a === "console"
            ? b !== "portal"
            : a === "portal"
              ? b !== "console"
              : true;
    if (!ok) offences.add(`${from} -> ${to}`);
  }
  return [...offences].sort();
}

/** Rule 4: what the portal entry reaches that it must not, with the path it takes. */
function portalReach(): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const { from, to, typeOnly } of ALL) {
    if (typeOnly) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
  }
  const entry = "portal/main.tsx";
  const via = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const at = queue.shift()!;
    for (const to of next.get(at) ?? []) {
      if (via.has(to)) continue;
      via.set(to, at);
      queue.push(to);
    }
  }
  const bad = new Map<string, string[]>();
  for (const module of via.keys()) {
    if (top(module) !== "console" && module !== "api.ts") continue;
    const chain: string[] = [];
    for (let m: string | null = module; m; m = via.get(m) ?? null)
      chain.unshift(m);
    bad.set(`${entry} -> ${module}`, chain);
  }
  return bad;
}

describe("admin layer boundaries", () => {
  it("sees the whole tree (the scan is not vacuous)", () => {
    expect(ALL.length).toBeGreaterThan(2000);
    expect(ALL.some((e) => e.from.startsWith("portal/"))).toBe(true);
    expect(ALL.some((e) => e.from.startsWith("ui/"))).toBe(true);
    expect(ALL.some((e) => e.from.startsWith("lib/"))).toBe(true);
  });

  it("lib/ and ui/ stay app-neutral, and the console and the portal never import each other", () => {
    const unknown = layerOffences().filter((edge) => !(edge in KNOWN));
    expect(
      unknown,
      "a new import crosses a layer: move the code to the right layer instead",
    ).toEqual([]);
  });

  it("the customer bundle reaches no console module and not api.ts", () => {
    const unknown = [...portalReach()]
      .filter(([edge]) => !(edge in KNOWN))
      .map(([, chain]) => chain.join(" -> "));
    expect(unknown, "the portal entry reaches console code through").toEqual(
      [],
    );
  });

  it("every KNOWN edge still exists (remove an entry with the change that fixes it)", () => {
    const live = new Set([...layerOffences(), ...portalReach().keys()]);
    const stale = Object.keys(KNOWN).filter((edge) => !live.has(edge));
    expect(stale).toEqual([]);
  });
});
