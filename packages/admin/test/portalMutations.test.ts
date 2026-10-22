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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { portalApi } from "../src/portal/api.js";
import {
  PORTAL_MUTATIONS,
  bindWriteInvalidation,
  invalidationFor,
  mutate,
} from "../src/portal/mutations.js";
import { qk } from "../src/portal/queries.js";

/**
 * The portal's mutation → invalidation table, checked from the outside: every `portalApi` method
 * is called against a recording fetch to learn which ones write, and the table must name exactly
 * those (the console's twin is test/mutations.test.ts).
 */

/** The HTTP verb each method sends, learned by calling it. A write anywhere in a method's
 *  requests makes it a write. */
async function httpMethods(): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  let current = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (seen[current] === undefined || seen[current] === "GET")
        seen[current] = method;
      return new Response("{}", { status: 200 });
    }),
  );
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: () => "blob:x",
      revokeObjectURL: () => undefined,
    }),
  );
  for (const name of Object.keys(portalApi)) {
    // finishPendingSignIn sends nothing unless this tab has a sign-in pending: start one first,
    // unrecorded.
    if (name === "finishPendingSignIn") {
      current = "(setup)";
      await portalApi.resendSignInCode().catch(() => undefined);
    }
    current = name;
    const fn = (
      portalApi as unknown as Record<string, (...a: unknown[]) => unknown>
    )[name]!;
    try {
      await fn("djdl", "id_1", "x", new Blob(["x"]));
    } catch {
      // A refusal or a parse error is fine; a method that never fetched is reported below.
    }
  }
  delete seen["(setup)"];
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("every portal write declares its invalidation", () => {
  it("classifies every portalApi method by calling it", async () => {
    const methods = await httpMethods();
    expect(Object.keys(methods).sort()).toEqual(Object.keys(portalApi).sort());
  });

  it("the table's keys are exactly the methods that send anything but GET", async () => {
    const methods = await httpMethods();
    const writes = Object.entries(methods)
      .filter(([, m]) => m !== "GET")
      .map(([name]) => name)
      .sort();
    expect(
      writes.filter((w) => !(w in PORTAL_MUTATIONS)),
      "writes with no entry in PORTAL_MUTATIONS",
    ).toEqual([]);
    expect(
      Object.keys(PORTAL_MUTATIONS).filter((k) => !writes.includes(k)),
      "PORTAL_MUTATIONS entries that are not writes",
    ).toEqual([]);
  });

  it("an entry that invalidates nothing says why", () => {
    for (const [name, spec] of Object.entries(PORTAL_MUTATIONS) as [
      string,
      {
        invalidates: (...a: string[]) => unknown[];
        settle?: (...a: string[]) => unknown[];
        removes?: (...a: string[]) => unknown[];
        why?: string;
        label: string;
      },
    ][]) {
      expect(spec.label, name).toBeTruthy();
      const args = ["djdl", "id_1", "x"];
      const touches =
        spec.invalidates(...args).length +
        (spec.settle?.(...args).length ?? 0) +
        (spec.removes?.(...args).length ?? 0);
      if (touches === 0)
        expect(
          spec.why,
          `${name} changes nothing and gives no reason`,
        ).toBeTruthy();
    }
  });

  it("reads are not in the table", () => {
    expect(invalidationFor("licenses", [])).toBeNull();
    expect(invalidationFor("me", [])).toBeNull();
  });
});

describe("declared targets (the gaps that mattered)", () => {
  const keys = (name: keyof typeof PORTAL_MUTATIONS, ...args: unknown[]) =>
    (invalidationFor(name, args) ?? []).map((t) => JSON.stringify(t.key));

  it("claimKey also refreshes the claimed product's view and downloads", () => {
    const k = keys("claimKey", "pkey_x");
    for (const want of [
      qk.licenses(),
      qk.releases(),
      qk.library(),
      qk.discover(),
      ["portal", "product"],
      ["portal", "downloads"],
    ])
      expect(k).toContain(JSON.stringify(want));
  });

  it("a removed licence's own view is dropped, not refetched", () => {
    const spec = PORTAL_MUTATIONS.removeLicense;
    expect(spec.removes("djdl", "L1").map((t) => t.key)).toEqual([
      qk.license("djdl", "L1"),
    ]);
    expect(keys("removeLicense", "djdl", "L1")).not.toContain(
      JSON.stringify(qk.license("djdl", "L1")),
    );
  });

  it("removing a library entry drops the product and its storefront page", () => {
    const removed = PORTAL_MUTATIONS.removeLibraryEntry
      .removes("djdl")
      .map((t) => t.key);
    expect(removed).toEqual([qk.product("djdl"), qk.storefront("djdl")]);
  });

  it("the claim from Discover settles on the library", () => {
    expect(PORTAL_MUTATIONS.claimDiscover.settle().map((t) => t.key)).toEqual([
      qk.library(),
    ]);
  });
});

describe("a write through the table", () => {
  let client: QueryClient;
  let unbind: () => void;
  beforeEach(() => {
    client = new QueryClient();
    unbind = bindWriteInvalidation(client);
  });
  afterEach(() => unbind());

  it("invalidates what claimKey declares after the server confirms", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
    client.setQueryData(qk.product("djdl"), {});
    client.setQueryData(qk.downloads("djdl"), {});
    client.setQueryData(qk.licenses(), []);
    await mutate("claimKey", "pkey_x");
    for (const key of [qk.product("djdl"), qk.downloads("djdl"), qk.licenses()])
      expect(
        client.getQueryState(key)?.isInvalidated,
        JSON.stringify(key),
      ).toBe(true);
  });

  it("invalidates nothing when the Worker refuses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })),
    );
    client.setQueryData(qk.licenses(), []);
    await expect(mutate("claimKey", "pkey_x")).rejects.toMatchObject({
      status: 404,
    });
    expect(client.getQueryState(qk.licenses())?.isInvalidated).toBe(false);
  });
});

describe("no portal write around the table", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const PORTAL = join(SRC, "portal");

  /**
   * Files that still call a `portalApi` write directly, each with the slice that moves it onto
   * the table (P0-32 B5). The list only shrinks: a new offender fails, and so does a listed file
   * with none left.
   */
  const KNOWN: Record<string, string> = {
    "App.tsx": "P0-32.6",
    "pages/SignInPage.tsx": "P0-32.7",
    "components/signin/FinishStep.tsx": "P0-32.7",
    "components/signin/DeviceStep.tsx": "P0-32.7",
    "components/signin/HintStep.tsx": "P0-32.7",
    "components/signin/RequestFlow.tsx": "P0-32.7",
    "components/signin/usePasskeySignIn.ts": "P0-32.7",
    "components/account/StepUp.tsx": "P0-32.8",
    "components/account/SignInMethods.tsx": "P0-32.8",
    "components/LinkAccountsDialog.tsx": "P0-32.8",
    "components/ApproveDeviceDialog.tsx": "P0-32.8",
  };

  /** The transport and the engine's own file may call writes. `queries.ts` calls
   *  `finishPendingSignIn` inside the session read, which is itself the refresh. */
  const EXEMPT = new Set(["api.ts", "mutations.ts", "queries.ts"]);
  const WRITES = new Set(Object.keys(PORTAL_MUTATIONS));

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }
  const rel = (file: string) => relative(PORTAL, file);
  const exempt = (file: string) =>
    EXEMPT.has(rel(file)) || rel(file).startsWith("api/");

  /**
   * Every way a file reaches a write without the table, on the AST: `portalApi.write(...)` over
   * line breaks, `portalApi["write"]`, `portalApi[x]`, `const a = portalApi`, `const { write } =
   * portalApi`, and the same through `import { portalApi as a }` or `import * as m`.
   */
  function offences(text: string): string[] {
    const sf = ts.createSourceFile("f.tsx", text, ts.ScriptTarget.Latest, true);
    const names = new Set<string>();
    const namespaces = new Set<string>();
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      if (!/(^|\/)api(\/index)?\.js$/.test(spec)) continue;
      const b = stmt.importClause.namedBindings;
      if (b && ts.isNamedImports(b))
        for (const el of b.elements)
          if ((el.propertyName ?? el.name).text === "portalApi")
            names.add(el.name.text);
      if (b && ts.isNamespaceImport(b)) namespaces.add(b.name.text);
    }
    if (!names.size && !namespaces.size) return [];
    const isApi = (n: ts.Node): boolean =>
      (ts.isIdentifier(n) && names.has(n.text)) ||
      (ts.isPropertyAccessExpression(n) &&
        n.name.text === "portalApi" &&
        ts.isIdentifier(n.expression) &&
        namespaces.has(n.expression.text));
    const found: string[] = [];
    const at = (n: ts.Node, what: string) =>
      found.push(
        `${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${what}`,
      );
    const visit = (n: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(n) &&
        isApi(n.expression) &&
        WRITES.has(n.name.text)
      )
        at(n, `portalApi.${n.name.text}`);
      else if (ts.isElementAccessExpression(n) && isApi(n.expression))
        at(n, "portalApi[...]");
      else if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        isApi(n.initializer)
      )
        at(n, "aliases or destructures portalApi");
      else if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isApi(n.right)
      )
        at(n, "assigns portalApi");
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  const offending = (): Map<string, string[]> => {
    const out = new Map<string, string[]>();
    for (const file of sources(PORTAL)) {
      if (exempt(file)) continue;
      const found = offences(readFileSync(file, "utf8"));
      if (found.length) out.set(rel(file), found);
    }
    return out;
  };

  it("every write goes through the table, bar the listed files", () => {
    const fresh = [...offending()]
      .filter(([file]) => !(file in KNOWN))
      .map(([file, f]) => `${file}: ${f.join(", ")}`);
    expect(fresh, "use useWrite or mutate from portal/mutations.ts").toEqual(
      [],
    );
  });

  it("every listed file still has a direct write (delete its entry when it stops)", () => {
    const found = offending();
    expect(Object.keys(KNOWN).filter((f) => !found.has(f))).toEqual([]);
  });

  it("the scan catches the shapes a regex would miss", () => {
    const imp = 'import { portalApi } from "./api.js";\n';
    const cases: [string, string][] = [
      [imp + "portalApi\n  .deleteMe();", "portalApi.deleteMe"],
      [
        'import { portalApi as a } from "../api.js";\na.claimKey("k");',
        "portalApi.claimKey",
      ],
      [imp + "const { claimKey } = portalApi;", "destructures"],
      [imp + "const x = portalApi;", "aliases"],
      [imp + 'portalApi["claimKey"]("k");', "portalApi[...]"],
      [
        'import * as m from "./api.js";\nm.portalApi.claimKey("k");',
        "portalApi.claimKey",
      ],
    ];
    for (const [code, expected] of cases)
      expect(offences(code).join("\n"), code).toContain(expected);
    // Reads are fine.
    expect(offences(imp + "void portalApi.licenses();")).toEqual([]);
  });

  it("a stray write in a new portal file fails the scan", () => {
    const probe = join(PORTAL, "__writeProbe__.ts");
    writeFileSync(
      probe,
      'import { portalApi } from "./api.js";\nexport const f = () => portalApi.deleteMe();\n',
    );
    try {
      expect(offending().has("__writeProbe__.ts")).toBe(true);
      expect("__writeProbe__.ts" in KNOWN).toBe(false);
    } finally {
      rmSync(probe, { force: true });
    }
  });
});
