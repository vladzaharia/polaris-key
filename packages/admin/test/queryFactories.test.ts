/**
 * Reads are spelled once. In the portal `portal/queries.ts` is the only file with a `queryFn`, and
 * the only one that builds a `queryKey` array: one `qk` entry and one `pq` factory per key family.
 * A hook calls `useQuery(pq.x(...))`, a write invalidates with `queryKey: qk.x(...)`.
 *
 * The console follows (P0-32.13 to .19): its data modules (`console/data/*.ts`,
 * `console/sections/<section>/data.ts`) are the only files with a `queryFn` or a bare `api.*`
 * member access, and each key family has one factory there. The files that still read around them
 * are listed in `KNOWN`, one block per section; the batch that migrates a section deletes its
 * block, and a block that no longer matches fails too.
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

const CONSOLE = join(SRC, "console");

/** The console's data modules: where a `queryFn`, a factory and an `api.*` read may live. */
const isDataModule = (file: string): boolean => {
  const rel = relative(CONSOLE, file).split("\\").join("/");
  return (
    /^data\/[^/]+\.tsx?$/.test(rel) || /^sections\/[^/]+\/data\.ts$/.test(rel)
  );
};

/** The section a console file belongs to: `sections/<name>`, else its top-level folder. */
const sectionOf = (file: string): string => {
  const parts = relative(CONSOLE, file).split("\\").join("/").split("/");
  return parts[0] === "sections" ? `sections/${parts[1]}` : parts[0]!;
};

const parse = (text: string) =>
  ts.createSourceFile("f.tsx", text, ts.ScriptTarget.Latest, true);

/** Is `node` a call `qk.name(...)` (or `qkFamily(...)`, a prefix)? */
function qkCall(node: ts.Expression): string | null {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "qkFamily" || node.expression.text === "qkAll")
  )
    return node.expression.text;
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

/** Member accesses on the `api` binding imported from `api.js` (`api.schema(slug)`). */
function apiReads(text: string): string[] {
  const sf = parse(text);
  let bound = false;
  for (const st of sf.statements)
    if (
      ts.isImportDeclaration(st) &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      /(^|\/)api\.js$/.test(st.moduleSpecifier.text)
    ) {
      const named = st.importClause?.namedBindings;
      if (
        named &&
        ts.isNamedImports(named) &&
        named.elements.some((e) => e.name.text === "api" && !e.propertyName)
      )
        bound = true;
    }
  if (!bound) return [];
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "api"
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      found.push(`${line} api.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** In a data module: a `queryFn` object that is not the argument of `queryOptions(...)`. */
function inlineReads(text: string): string[] {
  const sf = parse(text);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isObjectLiteralExpression(node) &&
      node.properties.some(
        (p) =>
          (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
          p.name.getText(sf) === "queryFn",
      )
    ) {
      const parent = node.parent;
      const factory =
        ts.isCallExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        (parent.expression.text === "queryOptions" ||
          parent.expression.text === "infiniteQueryOptions");
      if (!factory) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push(`${line} inline query (wrap it in queryOptions)`);
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

/**
 * Console files that still read around a data module, one block per section. P0-32.14 to .19
 * each delete theirs; the file is the unit, so a block lists every file that has a `queryFn`, a
 * `queryKey` that is not a `qk.x(...)` call, or an `api.*` member access.
 */
const KNOWN: Record<string, string[]> = {
  // P0-32.17
  "sections/config": [
    "sections/config/components/MintRecipeFields.tsx",
    "sections/config/components/RemovedValues.tsx",
    "sections/config/data.ts",
  ],
  // P0-32.17
  "sections/identity": [
    "sections/identity/components/SignInSections.tsx",
    "sections/identity/pages/AppSignIn.tsx",
  ],
  // P0-32.17
  "sections/license": [
    "sections/license/components/holders.tsx",
    "sections/license/components/shared.tsx",
    "sections/license/pages/EnrollmentPage.tsx",
    "sections/license/pages/LicenseConfig.tsx",
    "sections/license/pages/LicenseDelete.tsx",
    "sections/license/pages/LicenseRecord.tsx",
  ],
};

describe("console reads are factories", () => {
  const files = sources(CONSOLE);
  const offending = (f: string): string[] => {
    const text = readFileSync(f, "utf8");
    return isDataModule(f)
      ? inlineReads(text)
      : [...offences(text), ...apiReads(text)];
  };
  const listed = new Set(
    Object.values(KNOWN).flatMap((list) => list.map((p) => join(CONSOLE, p))),
  );

  it("reads are queryOptions factories in a data module (no queryFn, queryKey literal or api.* outside one), except KNOWN", () => {
    const offenders = files
      .filter((f) => !listed.has(f) && offending(f).length > 0)
      .map((f) => `${relative(SRC, f)}: ${offending(f).join(", ")}`);
    expect(offenders, "add a factory to the section's data.ts").toEqual([]);
  });

  it("every KNOWN file still offends, sits in its own section's block, and exists", () => {
    const stale = Object.entries(KNOWN).flatMap(([section, list]) =>
      list.flatMap((p) => {
        const file = join(CONSOLE, p);
        if (sectionOf(file) !== section) return [`${p} is not in ${section}`];
        try {
          return offending(file).length > 0
            ? []
            : [`${p} has no offence: delete it from KNOWN`];
        } catch {
          return [`${p} does not exist`];
        }
      }),
    );
    expect(stale).toEqual([]);
  });

  it("each qk family has one factory across the console's data modules", () => {
    const owner = new Map<string, string[]>();
    for (const f of sources(CONSOLE).filter(isDataModule)) {
      const sf = parse(readFileSync(f, "utf8"));
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const prop = (name: string) =>
            node.properties.find(
              (p): p is ts.PropertyAssignment =>
                ts.isPropertyAssignment(p) && p.name.getText(sf) === name,
            );
          const key = prop("queryKey");
          const family = key ? qkCall(key.initializer) : null;
          if (family && prop("queryFn"))
            owner.set(family, [
              ...(owner.get(family) ?? []),
              relative(CONSOLE, f),
            ]);
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    const dup = [...owner].filter(([, where]) => where.length > 1);
    expect(dup.map(([k, where]) => `qk.${k}: ${where.join(", ")}`)).toEqual([]);
  });

  it("a stray console read fails the scan, and a data module may hold it", () => {
    const probe = join(CONSOLE, "components", "__queryProbe__.ts");
    writeFileSync(
      probe,
      'import { api } from "../../api.js";\nexport const q = () => api.me();\n',
    );
    try {
      const stray = sources(CONSOLE)
        .filter((f) => !isDataModule(f) && offending(f).length > 0)
        .map((f) => relative(CONSOLE, f));
      expect(stray).toContain("components/__queryProbe__.ts");
      expect(apiReads("const api = {}; api.x();")).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
