import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  API_PATH,
  checkApi,
  renderNotes,
  scanGodot,
  scanKotlin,
} from "./api-check.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = (): any => JSON.parse(readFileSync(join(root, API_PATH), "utf8"));
const run = (mutate: (api: any) => void): string[] => {
  const api = real();
  mutate(api);
  return checkApi(root, {
    api,
    scanRoot: join(root, "tools/fixtures/api/none"),
  });
};
const concept = (api: any, id: string): any =>
  api.concepts.find((c: any) => c.id === id);

describe("api-check rule 4", () => {
  it("passes on the committed api.json", () => {
    expect(checkApi(root)).toEqual([]);
  });

  it("fails an SDK whose manifest implements the feature but is not listed (L11)", () => {
    const v = run((a) => {
      delete concept(a, "config.get").sdks.node;
    });
    expect(v).toContain(
      '[rule 8] config.get: node implements "config.resolve" (packages/sdk-node/parity.json) but is not listed on the concept',
    );
  });

  it("fails the schema", () => {
    const v = run((a) => {
      a.apiVersion = 2;
      concept(a, "config.get").kind = "verb";
    });
    expect(v.length).toBeGreaterThan(0);
    expect(
      v.every((l) => l.startsWith("[rule 8] conformance/parity/api.json")),
    ).toBe(true);
  });

  it("fails a planned package that is unknown", () => {
    const v = run((a) => {
      concept(a, "config.get").sdks.node.planned = "NOPE-1";
    });
    expect(v).toEqual([
      "[rule 8] config.get (node planned): NOPE-1 is not a work package",
    ]);
  });

  it("fails a planned package that is done", () => {
    const v = run((a) => {
      concept(a, "config.get").sdks.node.planned = "P0-42";
    });
    expect(v).toEqual([
      "[rule 8] config.get (node planned): P0-42 is done; drop the entry or row",
    ]);
  });

  it("fails an unknown feature and an unknown enum", () => {
    const v = run((a) => {
      concept(a, "config.get").feature = "config.nope";
      concept(a, "events").enum = "noSuchEnum";
    });
    expect(v).toContain('[rule 8] config.get: unknown feature "config.nope"');
    expect(v).toContain('[rule 8] events: unknown enum "noSuchEnum"');
  });

  it("fails a reserved package that is not a work package", () => {
    const v = run((a) => {
      concept(a, "client.doctor").reserved = "NOPE-2";
    });
    expect(v).toEqual([
      "[rule 8] client.doctor (reserved): NOPE-2 is not a work package",
    ]);
  });

  it("fails a common-word removal without a scan, and accepts one with a scan", () => {
    const row = {
      sdk: "python",
      from: "trust",
      to: "options.pinnedKeys",
      package: "SP-35",
    };
    expect(run((a) => a.removed.push(row))).toEqual([
      '[rule 8] removed trust: a common word needs its own "scan" (pattern or files)',
    ]);
    expect(
      run((a) => a.removed.push({ ...row, scan: { files: ["*.py"] } })),
    ).toEqual([]);
  });

  it("accepts a removal whose name is not a common word", () => {
    expect(
      run((a) =>
        a.removed.push({
          sdk: "node",
          from: "config.getConfig",
          to: "config.get",
          package: "SP-35",
        }),
      ),
    ).toEqual([]);
  });
});

describe("api-check rule 1 (surface scanners)", () => {
  const TS = "tools/fixtures/api/surface.ts";
  const PY = "tools/fixtures/api/surface.py";
  const withSurface = (
    sdk: string,
    file: string,
    type: string | undefined,
    mutate: (api: any) => void = () => {},
  ): string[] =>
    run((a) => {
      a.surfaces = { [sdk]: [{ ns: "config", type, file }] };
      a.concepts = a.concepts.filter(
        (c: any) =>
          (!c.id.startsWith("config.") || c.id === "config.get") &&
          !c.sdks?.[sdk]?.sdkOnly,
      );
      // The fixtures spell the call `getConfig`, as Node did before SP-35.14.
      if (sdk === "node")
        a.concepts.find((c: any) => c.id === "config.get").sdks.node = {
          spelling: "getConfig",
        };
      mutate(a);
    });

  it("the real registry records every SDK's surface (SP-35.8, .9, .10, .11, .12, .13)", () => {
    expect(Object.keys(real().surfaces)).toEqual([
      "node",
      "react",
      "python",
      "swift",
      "kotlin",
      "godot",
    ]);
  });

  it("scans a GDScript file's column-0 func, static func and signal, and skips _names and nested classes (SP-35.13)", () => {
    const src = [
      "extends RefCounted",
      "signal done(x: int)",
      "func one() -> void:",
      "\tpass",
      "static func two(a := 1):",
      "func _private():",
      "class Inner:",
      "\tfunc nested():",
      "\t\tpass",
      "var not_a_verb := 1",
    ].join("\n");
    expect(scanGodot(src)).toEqual(["done", "one", "two"]);
  });

  it("scans a Kotlin class whose constructor spans lines, a companion, and top-level extensions (SP-35.12)", () => {
    const src = [
      "public class A internal constructor(",
      "    private val f: () -> Double = { 1.0 },",
      "    val p: Int,",
      ") {",
      "    public fun one() {}",
      "    public companion object {",
      "        public fun make() {}",
      "    }",
      "}",
      "public data class Opts(",
      "    val leaked: Int,",
      ")",
      "public fun A.ext() {}",
    ].join("\n");
    expect(scanKotlin(src, "A")).toEqual(["one"]);
    expect(scanKotlin(src, "Companion")).toEqual(["make"]);
    expect(scanKotlin(src)).toEqual(["ext"]);
  });

  it("fails an unknown TypeScript verb; skips private, protected and _names", () => {
    const v = withSurface("node", TS, "FixtureClient");
    expect(v.sort()).toEqual(
      ["helper", "extra", "status"]
        .sort()
        .map(
          (n) =>
            `[rule 8] ${TS}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
        ),
    );
  });

  it("accepts a row spelling, an ignore entry and an sdkOnly entry (TypeScript)", () => {
    const v = withSurface("node", TS, "FixtureClient", (a) => {
      a.ignore.push({ sdk: "node", path: "FixtureClient.helper", reason: "x" });
      a.concepts.push({
        id: "config.extra",
        kind: "method",
        sdks: { node: { sdkOnly: true, reason: "x" } },
      });
      a.concepts.push({
        id: "config.status",
        kind: "property",
        sdks: { node: {} },
      });
    });
    expect(v).toEqual([]);
  });

  it("an ignore entry for another SDK does not cover", () => {
    const v = withSurface("node", TS, "FixtureClient", (a) => {
      a.ignore.push({ sdk: "python", path: "config.helper", reason: "x" });
    });
    expect(v.some((l) => l.includes("config.helper"))).toBe(true);
  });

  it("scans a file's exported functions and consts when no type is given (React)", () => {
    const v = withSurface("react", TS, undefined);
    expect(v.sort()).toEqual(
      ["useOther", "useThing"].map(
        (n) =>
          `[rule 8] ${TS}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
      ),
    );
    const ok = withSurface("react", TS, undefined, (a) => {
      a.concepts.push({
        id: "config.thing",
        kind: "hook",
        sdks: { react: { spelling: "useThing", shape: "hook" } },
      });
      a.ignore.push({ sdk: "react", path: "useOther", reason: "x" });
    });
    expect(ok).toEqual([]);
  });

  it("fails an unknown Python verb at class depth; skips _names, nested defs and other classes", () => {
    const v = withSurface("python", PY, "FixtureClient");
    expect(v.sort()).toEqual(
      ["get_value", "helper", "status", "sync_now"]
        .sort()
        .map(
          (n) =>
            `[rule 8] ${PY}: config.${n} is not a registry row, an sdks entry or an ignore entry`,
        ),
    );
  });

  it("accepts snake-cased rows, ignore and sdkOnly entries (Python)", () => {
    const v = withSurface("python", PY, "FixtureClient", (a) => {
      a.concepts.push({
        id: "config.getValue",
        kind: "method",
        sdks: { python: {} },
      });
      a.ignore.push({ path: "config.get_value", reason: "x" });
      a.ignore.push({ path: "FixtureClient.helper", reason: "x" });
      a.concepts.push({
        id: "config.syncNow",
        kind: "method",
        sdks: { python: { sdkOnly: true, reason: "x" } },
      });
      a.concepts.push({
        id: "config.status",
        kind: "property",
        sdks: { python: {} },
      });
    });
    expect(v).toEqual([]);
  });

  const camel = (n: string): string =>
    n.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  const msg = (file: string, n: string): string =>
    `[rule 8] ${file}: config.${n} is not a registry row, an sdks entry or an ignore entry`;
  const native: [string, string, string | undefined, string[], string[]][] = [
    [
      "swift",
      "tools/fixtures/api/surface.swift",
      "FixtureClient",
      ["getConfig", "helper", "extra", "status", "kind", "withBody"],
      [
        "internalByDefault",
        "explicitInternal",
        "secret",
        "hidden",
        "_underscore",
        "init",
        "nested",
        "notScanned",
      ],
    ],
    [
      "kotlin",
      "tools/fixtures/api/surface.kt",
      "FixtureClient",
      ["getConfig", "helper", "extra", "status", "withBody"],
      ["secret", "inner", "guarded", "_underscore", "nested", "notScanned"],
    ],
    [
      "godot",
      "tools/fixtures/api/surface.gd",
      undefined,
      ["status", "get_config", "helper", "extra"],
      ["_private_signal", "_ready"],
    ],
  ];
  for (const [sdk, file, type, unknown, skipped] of native) {
    it(`fails an unknown ${sdk} verb; skips private and underscore names`, () => {
      const v = withSurface(sdk, file, type);
      expect(v.sort()).toEqual(unknown.map((n) => msg(file, n)).sort());
      for (const n of skipped) expect(v.join()).not.toContain(`config.${n} `);
    });

    it(`accepts a row, an ignore entry and an sdkOnly entry (${sdk})`, () => {
      const v = withSurface(sdk, file, type, (a) => {
        const [first, second, ...rest] = unknown;
        a.ignore.push({ sdk, path: `config.${first}`, reason: "x" });
        a.concepts.push({
          id: `config.${camel(second!)}`,
          kind: "method",
          sdks: { [sdk]: {} },
        });
        for (const n of rest)
          a.concepts.push({
            id: `config.${camel(n)}`,
            kind: "method",
            sdks: { [sdk]: { sdkOnly: true, reason: "x" } },
          });
      });
      expect(v).toEqual([]);
    });

    it(`an ignore entry for another SDK does not cover (${sdk})`, () => {
      const other = sdk === "swift" ? "kotlin" : "swift";
      const v = withSurface(sdk, file, type, (a) => {
        a.ignore.push({
          sdk: other,
          path: `config.${unknown[0]}`,
          reason: "x",
        });
      });
      expect(v).toContain(msg(file, unknown[0]!));
    });

    it(`fails a missing ${sdk} surface file`, () => {
      expect(withSurface(sdk, "tools/fixtures/api/nope.x", type)).toEqual([
        "[rule 8] tools/fixtures/api/nope.x: surface file not found",
      ]);
    });
  }

  it("fails a surface file that does not exist", () => {
    expect(withSurface("node", "tools/fixtures/api/nope.ts", "X")).toEqual([
      "[rule 8] tools/fixtures/api/nope.ts: surface file not found",
    ]);
  });
});

describe("api-check rule 1 spelling namespaces (SP-35.8)", () => {
  const LIC = "tools/fixtures/api/surface2.ts";
  const lic = (mutate: (api: any) => void): string[] =>
    run((a) => {
      a.surfaces = {
        node: [{ ns: "license", type: "LicenseFixture", file: LIC }],
      };
      a.concepts = a.concepts.filter(
        (c: any) =>
          !c.reserved &&
          c.id !== "entitlements.has" &&
          !c.id.startsWith("license."),
      );
      a.ignore = [];
      a.concepts.push({
        id: "entitlements.has",
        kind: "method",
        sdks: { node: { spelling: "license.isEntitled" } },
      });
      mutate(a);
    });

  it("accepts a verb a row spells in the surface's namespace", () => {
    const v = lic(() => {});
    expect(v).toEqual([
      `[rule 8] ${LIC}: license.getQuantity is not a registry row, an sdks entry or an ignore entry`,
    ]);
  });

  it("does not accept it when no row spells it there", () => {
    const v = lic((a) => {
      concept(a, "entitlements.has").sdks.node.spelling = "entitlements.has";
    });
    expect(v.some((l) => l.includes("license.isEntitled"))).toBe(true);
  });
});

describe("api-check rule 3 (reserved names)", () => {
  const LIC = "tools/fixtures/api/surface2.ts";
  const reserved = (id: string): any => ({
    id,
    kind: "method",
    reserved: "LX-19",
  });
  const lic = (mutate: (api: any) => void): string[] =>
    run((a) => {
      a.surfaces = {
        node: [{ ns: "license", type: "LicenseFixture", file: LIC }],
      };
      a.concepts = a.concepts.filter((c: any) => !c.reserved);
      mutate(a);
    }).filter((l) => l.includes("reserved"));

  it("fails a second spelling of a reserved name", () => {
    const v = lic((a) => a.concepts.push(reserved("entitlements.quantity")));
    expect(v).toEqual([
      `[rule 8] ${LIC}: license.getQuantity spells the reserved name entitlements.quantity (LX-19); the only spelling is entitlements.quantity`,
    ]);
  });

  it("ignores a reserved name no verb spells, and one an SDK already lists", () => {
    expect(
      lic((a) => a.concepts.push(reserved("entitlements.grants"))),
    ).toEqual([]);
    expect(
      lic((a) => {
        const c = reserved("entitlements.quantity");
        c.sdks = { node: { spelling: "license.getQuantity" } };
        a.concepts.push(c);
      }),
    ).toEqual([]);
  });

  it("passes on the committed registry", () => {
    expect(checkApi(root).filter((l) => l.includes("reserved"))).toEqual([]);
  });
});

describe("api-check rule 2 (removed names)", () => {
  const scanRoot = join(root, "tools/fixtures/api/repo");
  const removed = (...rows: any[]): string[] => {
    const api = real();
    api.removed = rows; // the fixture tree, not the real removed rows
    return checkApi(root, { api, scanRoot });
  };
  const node = {
    sdk: "node",
    from: "config.getConfig",
    to: "config.get",
    package: "SP-35",
  };

  it("passes on the committed registry and tree", () => {
    expect(checkApi(root)).toEqual([]);
  });

  it("fails a removed name in SDK source; api-allow on the line or the line above opts out", () => {
    const v = removed(node).filter(
      (l) => l.includes("sdk-node") && l.includes("removed node"),
    );
    expect(v).toEqual(
      ["packages/sdk-node/src/client.ts:3"].map(
        (p) =>
          `[rule 8] ${p}: removed node name "config.getConfig" (SP-35); use config.get`,
      ),
    );
  });

  it("fails an api-allow with no reason, and still reports the line", () => {
    const v = removed({ ...node, from: "config.getConfigSource" });
    expect(v).toEqual([
      '[rule 8] packages/sdk-node/src/client.ts:8: removed node name "config.getConfigSource" (SP-35); use config.get',
      "[rule 8] packages/sdk-node/src/client.ts:9: api-allow needs a reason",
      '[rule 8] packages/sdk-node/src/client.ts:9: removed node name "config.getConfigSource" (SP-35); use config.get',
    ]);
  });

  it("fails a removed name in a docs fence of the SDK's language only", () => {
    const v = removed(node).filter((l) => l.includes("guide.md"));
    expect(v).toEqual([
      '[rule 8] packages/docs/src/content/docs/build/guide.md:4: removed node name "config.getConfig" (SP-35); use config.get',
    ]);
  });

  it("does not scan another language's sources", () => {
    const v = removed(node);
    expect(v.some((l) => l.includes("sdks/python"))).toBe(false);
  });

  it("a row's scan: Python trust hits Python source and fences, not Core's keyword or discovery JSON", () => {
    const trust = {
      sdk: "python",
      from: "trust",
      to: "options.pinnedKeys",
      package: "SP-35",
      scan: {
        pattern: '\\btrust\\s*=\\s*(dict\\(|\\{|PINNED)|"trust"\\s*:',
        files: ["*.py", "*.rpy", "fence:python"],
      },
    };
    const v = removed(trust).map((l) => l.replace(/ \(SP-35\).*/, ""));
    expect(v.sort()).toEqual(
      [
        '[rule 8] packages/docs/src/content/docs/build/guide.md:12: removed python name "trust"',
        '[rule 8] sdks/python/src/core.py:3: removed python name "trust"',
        '[rule 8] sdks/python/src/core.py:4: removed python name "trust"',
      ].sort(),
    );
    expect(v.some((l) => l.includes("discovery"))).toBe(false);
  });

  it("an option row matches `name=` and `name:` by default", () => {
    const opt = {
      sdk: "python",
      from: "trust",
      to: "options.pinnedKeys",
      package: "SP-35",
      scan: { files: ["*.py"] },
    };
    const v = removed(opt);
    expect(v.filter((l) => l.includes("core.py")).length).toBe(3);
  });
});

describe("api-check --notes", () => {
  it("prints a package's removed rows as a Markdown table", () => {
    const api = real();
    api.removed.push(
      {
        sdk: "node",
        from: "config.getConfig",
        to: "config.get",
        package: "SP-35",
      },
      {
        sdk: "react",
        from: "auth.cookie",
        note: "bearer mode | redirect",
        package: "SP-40",
      },
    );
    const md = renderNotes(api, "SP-35");
    expect(md).toContain("### Removed in SP-35");
    expect(md).toContain("| node | `config.getConfig` | `config.get` |");
    expect(md).not.toContain("auth.cookie");
    expect(renderNotes(api, "SP-40")).toContain("bearer mode \\| redirect");
    expect(renderNotes(api, "NOPE")).toContain("| none | | |");
  });
});
