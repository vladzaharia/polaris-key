// @pkey-feature config.mirror
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { ConfigEntry, ProductCatalog } from "@polaris-key/catalog";
import {
  DEFAULT_KOTLIN_PACKAGE,
  gdStr,
  gdValue,
  ktStr,
  renderGdscript,
  renderKotlin,
  renderPython,
  renderSwift,
  renderTs,
  settingPolicies,
  sortedJson,
} from "./gen-mirrors.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The Godot runner loads this pair (sdks/godot/tests/config/): the sample must be exactly what
 *  the renderer writes for the fixture catalog, so the runner is testing today's renderer. */
const GODOT_FIXTURE = join(ROOT, "sdks/godot/tests/config/catalog.json");
const GODOT_SAMPLE = join(ROOT, "sdks/godot/tests/config/catalog_generated.gd");
/** The Kotlin SDK's :config tests COMPILE this sample (P6-07): it must be exactly what the
 *  renderer writes for the fixture catalog, in the package the test module imports. */
const KOTLIN_FIXTURE = join(
  ROOT,
  "sdks/kotlin/config/src/test/resources/catalog.json",
);
const KOTLIN_SAMPLE = join(
  ROOT,
  "sdks/kotlin/config/src/test/kotlin/im/plrs/key/config/mirror/ConfigSchema.generated.kt",
);
const KOTLIN_SAMPLE_PACKAGE = "im.plrs.key.config.mirror";

const CATALOG: ProductCatalog = {
  schemaVersion: 2,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "Run",
      label: "Parallel",
      description: "How many.",
      accessor: "run.concurrency",
      schema: { type: "integer", minimum: 1, maximum: 8 },
      managementDefault: "default",
      ui: { widget: "stepper" },
    },
    {
      key: "polarisVpn",
      kind: "flag",
      category: "VPN",
      label: "VPN",
      description: "Master switch.",
      schema: { type: "boolean" },
      userGrant: true,
      grantLabel: "Polaris VPN",
    },
  ],
};

const [RUN, VPN] = CATALOG.entries as [ConfigEntry, ConfigEntry];

describe("gen-mirrors", () => {
  it("TS mirror has version, key union, and data", () => {
    const out = renderTs(CATALOG);
    expect(out).toContain("CATALOG_VERSION = 2");
    expect(out).toContain('"run.concurrency" | "polarisVpn"');
    expect(out).toContain('"key": "run.concurrency"');
    expect(out).toContain("export const entryByKey");
  });

  it("Python mirror has dataclass, Literal keys, and entries", () => {
    const out = renderPython(CATALOG);
    expect(out).toContain("CATALOG_VERSION = 2");
    expect(out).toContain('Literal["run.concurrency", "polarisVpn"]');
    expect(out).toContain('ConfigEntry(key="run.concurrency"');
    expect(out).toContain("user_grant=True");
    expect(out).toContain("def entry_by_key");
  });

  it("Swift mirror has struct, enum, and entries", () => {
    const out = renderSwift(CATALOG);
    expect(out).toContain("struct ConfigSchemaEntry");
    expect(out).toContain("enum ProductCatalog");
    expect(out).toContain("static let version = 2");
    expect(out).toContain(
      'ConfigSchemaEntry(key: "run.concurrency", kind: .config',
    );
    expect(out).toContain("kind: .flag");
  });

  it("Swift mirror escapes the `default` reserved word in the enum + member access", () => {
    const out = renderSwift(CATALOG);
    // The enum case is backtick-escaped.
    expect(out).toContain(
      "enum ManagementState: String { case `default`, enforced, hidden }",
    );
    // A managementDefault of "default" emits an escaped member access, not `.default`.
    expect(out).toContain("managementDefault: .`default`");
    expect(out).not.toContain("managementDefault: .default");
  });

  describe("settable keys (plans/U-01b.md D2)", () => {
    const WITH_USER: ProductCatalog = {
      ...CATALOG,
      entries: [
        { ...RUN, user: { sync: "user", conflict: "max" } },
        VPN,
        {
          key: "ui.panel",
          kind: "config",
          category: "UI",
          label: "Panel",
          description: "",
          schema: { type: "string" },
          user: { sync: "local", listed: false },
        },
        {
          key: "ui.accent",
          kind: "config",
          category: "UI",
          label: "Accent",
          description: "",
          schema: { type: "string" },
        },
        {
          key: "ops.region",
          kind: "config",
          category: "Ops",
          label: "Region",
          description: "",
          schema: { type: "string" },
          managementDefault: "enforced",
          user: { sync: "user" },
        },
      ],
    };

    it("lists every Editable config key, with or without a user block, defaults applied", () => {
      expect(settingPolicies(WITH_USER)).toEqual([
        { key: "run.concurrency", sync: "user", conflict: "max", listed: true },
        {
          key: "ui.panel",
          sync: "local",
          conflict: "lastWrite",
          listed: false,
        },
        {
          key: "ui.accent",
          sync: "user",
          conflict: "lastWrite",
          listed: true,
        },
      ]);
      // Negative control: a locked key (even with a user block) and a flag are not settable.
      const keys = settingPolicies(WITH_USER).map((p) => p.key);
      expect(keys).not.toContain("ops.region");
      expect(keys).not.toContain(VPN.key);
    });

    it("every language names the typed settable keys and their policies", () => {
      const ts = renderTs(WITH_USER);
      expect(ts).toContain(
        'export type UserSettingKey = "run.concurrency" | "ui.panel" | "ui.accent";',
      );
      expect(ts).toContain(
        '"ui.panel": { sync: "local", conflict: "lastWrite", listed: false },',
      );
      expect(ts).toContain(
        'export type UserSettingSync = "user" | "platform" | "local";',
      );
      expect(ts).not.toContain('"device"');
      const py = renderPython(WITH_USER);
      expect(py).toContain(
        'UserSettingKey = Literal["run.concurrency", "ui.panel", "ui.accent"]',
      );
      expect(py).toContain(
        '"run.concurrency": UserSettingPolicy(sync="user", conflict="max", listed=True),',
      );
      expect(renderSwift(WITH_USER)).toContain(
        '"ui.panel": UserSettingPolicy(sync: "local", conflict: "lastWrite", listed: false),',
      );
      expect(renderGdscript(WITH_USER)).toContain(
        'const USER_SETTINGS := {\n\t"run.concurrency": {\n\t\t"conflict": "max",',
      );
      expect(renderKotlin(WITH_USER)).toContain(
        '"run.concurrency" to UserSettingPolicy(sync = "user", conflict = "max", listed = true),',
      );
    });

    it("a catalog of only locked keys, secrets and flags has no settable key", () => {
      const NONE: ProductCatalog = {
        ...CATALOG,
        entries: CATALOG.entries.filter((e) => e.kind !== "config"),
      };
      expect(settingPolicies(NONE)).toEqual([]);
      expect(renderTs(NONE)).toContain("export type UserSettingKey = never;");
      // `Literal[]` does not parse.
      expect(renderPython(NONE)).toContain("UserSettingKey = str\n");
      expect(renderSwift(NONE)).toContain(
        "static let userSettings: [String: UserSettingPolicy] = [:]",
      );
      expect(renderKotlin(NONE)).toContain(
        "userSettings: Map<String, UserSettingPolicy> = emptyMap()",
      );
    });
  });

  describe("GDScript mirror", () => {
    it("has the version, the keys, the entries and entry_by_key", () => {
      const out = renderGdscript(CATALOG);
      expect(out).toContain("const CATALOG_VERSION := 2\n");
      expect(out).toContain(
        'const KEYS := [\n\t"run.concurrency",\n\t"polarisVpn",\n]',
      );
      expect(out).toContain("const ENTRIES := [");
      expect(out).toContain('\t\t"key": "run.concurrency",');
      expect(out).toContain('\t\t"kind": "flag",');
      expect(out).toContain(
        "static func entry_by_key(key: String) -> Dictionary:",
      );
      expect(out).toContain(
        "static func entries_by_kind(kind: String) -> Array:",
      );
      // No global class name: a game may mirror more than one product.
      expect(out).not.toContain("class_name");
      expect(out.startsWith("# @generated by tools/gen-mirrors.ts")).toBe(true);
    });

    it("sorts object keys and keeps the entry order", () => {
      const out = renderGdscript(CATALOG);
      const entry = out.slice(out.indexOf("const ENTRIES"));
      const order = ["accessor", "category", "description", "key", "kind"].map(
        (k) => entry.indexOf(`"${k}":`),
      );
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(entry.indexOf('"run.concurrency"')).toBeLessThan(
        entry.indexOf('"polarisVpn"'),
      );
      // Reordering the source object's keys changes nothing.
      const shuffled: ProductCatalog = {
        schemaVersion: 2,
        entries: CATALOG.entries.map(
          (e) =>
            Object.fromEntries(
              Object.entries(e).reverse(),
            ) as unknown as (typeof CATALOG.entries)[number],
        ),
      };
      expect(renderGdscript(shuffled)).toBe(out);
    });

    it("emits DEFAULTS for config keys only, sorted, never a secret's", () => {
      const out = renderGdscript({
        schemaVersion: 1,
        entries: [
          { ...RUN, key: "z.last", default: 3 },
          {
            ...RUN,
            key: "a.first",
            default: { b: [1, 2.5], a: null },
          },
          { ...VPN, default: true },
          {
            ...RUN,
            key: "api.key",
            kind: "secret",
            default: "hunter2",
            delivery: "edgeMint",
          },
        ],
      });
      const defaults = out.slice(out.indexOf("const DEFAULTS"));
      expect(defaults).toContain(
        'const DEFAULTS := {\n\t"a.first": {\n\t\t"a": null,\n\t\t"b": [\n\t\t\t1,\n\t\t\t2.5,\n\t\t],\n\t},\n\t"z.last": 3,\n}',
      );
      expect(defaults).not.toContain("polarisVpn");
      expect(out).not.toContain("hunter2");
      expect(out).toContain('"delivery": "edgeMint"');
    });

    it("escapes quotes, backslashes, control characters and non-ASCII labels", () => {
      expect(gdStr('say "hi"')).toBe('"say \\"hi\\""');
      expect(gdStr("a\\b")).toBe('"a\\\\b"');
      expect(gdStr("one\ntwo\tthree\r")).toBe('"one\\ntwo\\tthree\\r"');
      expect(gdStr("bell\u0007 del\u007f")).toBe('"bell\\u0007 del\\u007F"');
      expect(gdStr("Música ×")).toBe('"M\\u00FAsica \\u00D7"');
      expect(gdStr("dice 🎲")).toBe('"dice \\U01F3B2"');
      // ASCII only on output, whatever the input.
      const out = renderGdscript({
        schemaVersion: 1,
        entries: [{ ...RUN, label: 'Música "principal" 🎲 \\ ☾' }],
      });
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7f]*$/.test(out.slice(out.indexOf("\n")))).toBe(true);
      expect(out).toContain(
        '"label": "M\\u00FAsica \\"principal\\" \\U01F3B2 \\\\ \\u263E",',
      );
    });

    it("writes numbers GDScript parses with the right type", () => {
      expect(gdValue(3)).toBe("3");
      expect(gdValue(-0)).toBe("0");
      expect(gdValue(1.5)).toBe("1.5");
      expect(gdValue(1e-7)).toBe("1e-7");
      expect(gdValue(1e21)).toBe("1e+21");
      // Beyond 2^53 an integer is written as a float literal, never an int64 overflow.
      expect(gdValue(2 ** 60)).toBe("1152921504606847000.0");
      expect(gdValue([])).toBe("[]");
      expect(gdValue({})).toBe("{}");
      expect(gdValue(null)).toBe("null");
    });

    it("the Godot runner's sample is today's output for its fixture", () => {
      const catalog = JSON.parse(
        readFileSync(GODOT_FIXTURE, "utf8"),
      ) as ProductCatalog;
      expect(readFileSync(GODOT_SAMPLE, "utf8")).toBe(renderGdscript(catalog));
    });
  });

  describe("Kotlin mirror", () => {
    it("has the package, the version, the entries and the lookups", () => {
      const out = renderKotlin(CATALOG);
      expect(out.startsWith("// @generated by tools/gen-mirrors.ts")).toBe(
        true,
      );
      expect(out).toContain(`package ${DEFAULT_KOTLIN_PACKAGE}\n`);
      expect(out).toContain("public const val VERSION: Int = 2\n");
      expect(out).toContain('            key = "run.concurrency",');
      expect(out).toContain("            kind = ConfigKind.flag,");
      expect(out).toContain(
        "            managementDefault = ManagementState.default,",
      );
      expect(out).toContain('            grantLabel = "Polaris VPN",');
      expect(out).toContain(
        "public fun entry(key: String): ConfigSchemaEntry? = entries.firstOrNull { it.key == key }",
      );
      expect(renderKotlin(CATALOG, "com.example.game")).toContain(
        "package com.example.game\n",
      );
    });

    it("refuses a package name Kotlin would not parse", () => {
      expect(() => renderKotlin(CATALOG, "com.example-game")).toThrow();
      expect(() => renderKotlin(CATALOG, "1abc")).toThrow();
    });

    it("escapes quotes, backslashes, templates, control characters and non-ASCII text", () => {
      expect(ktStr('say "hi"')).toBe('"say \\"hi\\""');
      expect(ktStr("a\\b")).toBe('"a\\\\b"');
      expect(ktStr("costs $5 ${x}")).toBe('"costs \\$5 \\${x}"');
      expect(ktStr("one\ntwo\tthree\r")).toBe('"one\\ntwo\\tthree\\r"');
      expect(ktStr("bell\u0007 del\u007f")).toBe('"bell\\u0007 del\\u007F"');
      expect(ktStr("Música 🎲")).toBe('"M\\u00FAsica \\uD83C\\uDFB2"');
      const out = renderKotlin({
        schemaVersion: 1,
        entries: [{ ...RUN, label: 'Música "principal" 🎲 \\ ☾ $' }],
      });
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7f]*$/.test(out.slice(out.indexOf("\n")))).toBe(true);
    });

    it("writes JSON text with sorted keys and never a secret's default", () => {
      expect(sortedJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe(
        '{"a":null,"b":[1,{"c":2,"d":1}]}',
      );
      const out = renderKotlin({
        schemaVersion: 1,
        entries: [
          { ...RUN, key: "a.first", default: { b: 2, a: 1 } },
          {
            ...RUN,
            key: "api.key",
            kind: "secret",
            default: "hunter2",
            delivery: "edgeMint",
          },
        ],
      });
      expect(out).toContain('defaultJson = "{\\"a\\":1,\\"b\\":2}",');
      expect(out).not.toContain("hunter2");
      expect(out).toContain(
        'schemaJson = "{\\"maximum\\":8,\\"minimum\\":1,\\"type\\":\\"integer\\"}",',
      );
    });

    it("the Kotlin SDK's compiled sample is today's output for its fixture", () => {
      const catalog = JSON.parse(
        readFileSync(KOTLIN_FIXTURE, "utf8"),
      ) as ProductCatalog;
      expect(readFileSync(KOTLIN_SAMPLE, "utf8")).toBe(
        renderKotlin(catalog, KOTLIN_SAMPLE_PACKAGE),
      );
    });
  });
});
