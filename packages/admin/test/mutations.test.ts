import {
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import ts from "typescript";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryKey } from "@tanstack/react-query";
import { api, setLoginRedirectForTests } from "../src/api.js";
import {
  MUTATIONS,
  invalidateAfter,
  invalidationFor,
  mutate,
  type WriteMethod,
} from "../src/console/data/mutations.js";
import { qk } from "../src/console/data/queries.js";
import { queryClient } from "../src/console/data/queryClient.js";

/**
 * The mutation → invalidation table (docs/design/ADMIN.md §5.4; fixes CC-1 to CC-4).
 *
 * The table is only worth anything if it is complete and actually used, so this suite checks both
 * from the outside: it calls every API method against a recording fetch to learn which ones write,
 * and it reads the source for writes that bypass `mutate`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

/** The HTTP method each API method sends, learned by calling it. */
async function httpMethods(): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  let current = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen[current] = init?.method ?? "GET";
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  for (const name of Object.keys(api)) {
    current = name;
    const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[
      name
    ]!;
    try {
      await fn("djdl", "id_1", "x", {}, null, true);
    } catch {
      // A method that throws before fetching is reported by the "classifies every" test.
    }
  }
  return seen;
}

beforeEach(() => {
  queryClient.clear();
  setLoginRedirectForTests(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every write declares its invalidation", () => {
  it("classifies every API method by calling it", async () => {
    const methods = await httpMethods();
    expect(Object.keys(methods).sort()).toEqual(Object.keys(api).sort());
  });

  it("the table's keys are exactly the API methods that send anything but GET", async () => {
    const methods = await httpMethods();
    const writes = Object.entries(methods)
      .filter(([, m]) => m !== "GET")
      .map(([name]) => name)
      .sort();
    expect(
      writes.filter((w) => !(w in MUTATIONS)),
      "writes with no entry in MUTATIONS",
    ).toEqual([]);
    expect(
      Object.keys(MUTATIONS).filter((k) => !writes.includes(k)),
      "MUTATIONS entries that are not writes",
    ).toEqual([]);
  });

  it("an entry that invalidates nothing says why", () => {
    for (const [name, spec] of Object.entries(MUTATIONS)) {
      const targets = spec.invalidates(
        ...(["djdl", "id_1", "confirm"] as never[]),
      );
      expect(Array.isArray(targets), name).toBe(true);
      if (targets.length === 0) {
        expect(
          spec.why,
          `${name} invalidates nothing and gives no reason`,
        ).toBeTruthy();
      }
    }
  });

  it("reads are not in the table", () => {
    expect(invalidationFor("licenses", ["djdl"])).toBeNull();
    expect(invalidationFor("me", [])).toBeNull();
  });
});

describe("no view writes around mutate()", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  const ADMIN_API = join(src, "api.ts");
  const EXEMPT = [ADMIN_API, join(src, "console", "data", "mutations.ts")];
  const WRITES = new Set<string>(Object.keys(MUTATIONS));

  /**
   * Every way a file can reach a write without `mutate`, found on the AST (so line breaks,
   * aliases and destructuring cannot hide one): `api.write(...)` however it is split across
   * lines, `api["write"]` or `api[x]`, `const a = api` / `const { write } = api`, and the same
   * through `import { api as a }` or `import * as m` (`m.api.write`).
   */
  function offences(file: string): string[] {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const apiNames = new Set<string>();
    const namespaces = new Set<string>();
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const target = join(dirname(file), spec).replace(/\.js$/, ".ts");
      if (target !== ADMIN_API) continue;
      const bindings = stmt.importClause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          if ((el.propertyName ?? el.name).text === "api")
            apiNames.add(el.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
    }
    if (apiNames.size === 0 && namespaces.size === 0) return [];
    const isApi = (node: ts.Node): boolean =>
      (ts.isIdentifier(node) && apiNames.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        node.name.text === "api" &&
        ts.isIdentifier(node.expression) &&
        namespaces.has(node.expression.text));
    const found: string[] = [];
    const at = (node: ts.Node, what: string): void => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${relative(src, file)}:${line + 1} ${what}`);
    };
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        isApi(node.expression) &&
        WRITES.has(node.name.text)
      ) {
        at(node, `api.${node.name.text}`);
      } else if (ts.isElementAccessExpression(node) && isApi(node.expression)) {
        at(node, "api[...]");
      } else if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        isApi(node.initializer)
      ) {
        at(node, "aliases or destructures api");
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isApi(node.right)
      ) {
        at(node, "assigns api");
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  }

  it("every write in src/ goes through mutate()", () => {
    const offenders = sources(src)
      .filter((f) => !EXEMPT.includes(f))
      .flatMap(offences);
    expect(offenders, "call mutate(...) instead").toEqual([]);
  });

  it("the check catches the shapes a regex would miss", () => {
    const probe = join(src, "views", "__probe__.ts");
    const cases: [string, string][] = [
      [
        'import { api } from "../api.js";\napi\n  .createTier("s", {} as never);',
        "api.createTier",
      ],
      [
        'import { api as a } from "../api.js";\na.deleteTier("s", "t");',
        "api.deleteTier",
      ],
      [
        'import { api } from "../api.js";\nconst { createTier } = api;',
        "destructures",
      ],
      ['import { api } from "../api.js";\nconst x = api;', "aliases"],
      [
        'import { api } from "../api.js";\napi["createTier"]("s", {} as never);',
        "api[...]",
      ],
      [
        'import * as m from "../api.js";\nm.api.patchTier("s", "t", {} as never);',
        "api.patchTier",
      ],
    ];
    for (const [code, expected] of cases) {
      writeFileSync(probe, code);
      try {
        expect(offences(probe).join("\n"), code).toContain(expected);
      } finally {
        rmSync(probe, { force: true });
      }
    }
    // Reads are fine.
    writeFileSync(
      probe,
      'import { api } from "../api.js";\nvoid api.licenses("s");',
    );
    try {
      expect(offences(probe)).toEqual([]);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});

/** Seed one query per key, run a write's invalidation, and return which keys went stale. */
function staleAfter(
  method: WriteMethod,
  args: unknown[],
  keys: Record<string, QueryKey>,
): string[] {
  for (const key of Object.values(keys)) queryClient.setQueryData(key, {});
  invalidateAfter(method, args);
  return Object.entries(keys)
    .filter(([, key]) => queryClient.getQueryState(key)?.isInvalidated)
    .map(([name]) => name)
    .sort();
}

describe("the stale-cache bugs stay fixed", () => {
  it("CC-1: a product create or delete refreshes the session, so the switcher and Home update", () => {
    const keys = {
      me: qk.me(),
      products: qk.products(),
      other: qk.catalog("acme"),
    };
    expect(staleAfter("createManualProduct", [{ slug: "new" }], keys)).toEqual([
      "me",
      "products",
    ]);
    queryClient.clear();
    expect(staleAfter("linkRepo", ["https://github.com/a/b"], keys)).toEqual([
      "me",
      "products",
    ]);
    queryClient.clear();
    expect(staleAfter("deleteProduct", ["djdl"], keys)).toEqual([
      "me",
      "products",
    ]);
  });

  it("CC-1: a product edit refreshes the registry, the product row and the session", () => {
    expect(
      staleAfter("updateProduct", ["djdl", {}], {
        me: qk.me(),
        products: qk.products(),
        product: qk.product("djdl"),
        catalog: qk.catalog("djdl"),
      }),
    ).toEqual(["me", "product", "products"]);
  });

  it("CC-2: a resync refreshes everything it re-applies", () => {
    const keys = {
      product: qk.product("djdl"),
      catalog: qk.catalog("djdl"),
      profiles: qk.profiles("djdl"),
      tiers: qk.tiers("djdl"),
      services: qk.services("djdl"),
      channels: qk.channels("djdl"),
      health: qk.releaseHealth("djdl"),
      feed: qk.feed("djdl"),
      access: qk.access("djdl"),
      portal: qk.portal("djdl"),
      otherProduct: qk.catalog("acme"),
    };
    const stale = staleAfter("resyncProduct", ["djdl"], keys);
    expect(stale).not.toContain("otherProduct");
    expect(stale).toEqual(
      Object.keys(keys)
        .filter((k) => k !== "otherProduct")
        .sort(),
    );
  });

  it("CC-3: a yank refreshes Compatibility, the Matrix, deliverables and pack releases too", () => {
    const keys = {
      releases: qk.releases("djdl"),
      channels: qk.channels("djdl"),
      health: qk.releaseHealth("djdl"),
      deliverables: qk.deliverables("djdl"),
      compat: qk.compat("djdl", 0),
      packReleases: qk.packReleases("djdl", "core"),
      matrix: qk.matrix("djdl", "app"),
      liveness: qk.matrix("djdl", "compat"),
    };
    for (const method of [
      "yankRelease",
      "unyankRelease",
      "updateReleaseChannel",
      "revertReleaseChannel",
      "setChannelFloor",
    ] as WriteMethod[]) {
      queryClient.clear();
      expect(staleAfter(method, ["djdl", "x", "y"], keys), method).toEqual(
        Object.keys(keys).sort(),
      );
    }
  });

  it("CC-4: a rollout verb refreshes the compatibility overlay and health, not just the matrix", () => {
    expect(
      staleAfter("rolloutAction", ["djdl", "appstore", "stable", "pause", {}], {
        matrix: qk.matrix("djdl", "app"),
        liveness: qk.matrix("djdl", "compat"),
        rollouts: qk.rollouts("djdl"),
        health: qk.health("djdl"),
        compat: qk.compat("djdl", 0),
      }),
    ).toEqual(["compat", "health", "liveness", "matrix", "rollouts"]);
  });

  it("CC-4: confirming a Sentry candidate (which halts the rollout) refreshes rollouts and the matrix", () => {
    const keys = {
      health: qk.health("djdl"),
      rollouts: qk.rollouts("djdl"),
      matrix: qk.matrix("djdl", "app"),
    };
    expect(
      staleAfter("decideCandidate", ["djdl", "c1", "confirm"], keys),
    ).toEqual(["health", "matrix", "rollouts"]);
    queryClient.clear();
    expect(
      staleAfter("decideCandidate", ["djdl", "c1", "dismiss"], keys),
    ).toEqual(["health"]);
  });

  it("a catalog publish re-validates every license record", () => {
    expect(
      staleAfter("publishSchema", ["djdl", {}], {
        catalog: qk.catalog("djdl"),
        profiles: qk.profiles("djdl"),
        profile: qk.profile("djdl", "trial"),
        license: qk.license("djdl", "lic_1"),
      }),
    ).toEqual(["catalog", "license", "profile", "profiles"]);
  });

  it("a license-scoped device or key action refreshes that license and the list's counts, not other licenses", () => {
    const keys = {
      devices: qk.devicesSummary("djdl"),
      list: qk.licenses("djdl"),
      mine: qk.license("djdl", "lic_1"),
      other: qk.license("djdl", "lic_2"),
    };
    expect(
      staleAfter("deauthorizeDevice", ["djdl", "lic_1", "dev_1"], keys),
    ).toEqual(["devices", "list", "mine"]);
    for (const method of ["mintKey", "revokeKey"] as WriteMethod[]) {
      queryClient.clear();
      expect(staleAfter(method, ["djdl", "lic_1", "k"], keys), method).toEqual([
        "list",
        "mine",
      ]);
    }
  });
});

describe("mutate()", () => {
  it("calls the API, then invalidates what the write declared", async () => {
    const spy = vi
      .spyOn(api, "createTier")
      .mockResolvedValue({ ok: true, id: "pro" });
    queryClient.setQueryData(qk.tiers("djdl"), {});
    const result = await mutate("createTier", "djdl", { name: "Pro" } as never);
    expect(result).toEqual({ ok: true, id: "pro" });
    expect(spy).toHaveBeenCalledWith("djdl", { name: "Pro" });
    expect(queryClient.getQueryState(qk.tiers("djdl"))?.isInvalidated).toBe(
      true,
    );
  });

  it("invalidates nothing when the write fails, and rethrows", async () => {
    vi.spyOn(api, "deleteTier").mockRejectedValue(new Error("in use"));
    queryClient.setQueryData(qk.tiers("djdl"), {});
    await expect(mutate("deleteTier", "djdl", "pro")).rejects.toThrow("in use");
    expect(queryClient.getQueryState(qk.tiers("djdl"))?.isInvalidated).toBe(
      false,
    );
  });
});
