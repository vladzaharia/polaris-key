import { describe, it, expect } from "vitest";
import type { ProductCatalog } from "@plrs/catalog";
import { renderTs, renderPython, renderSwift } from "./gen-mirrors.js";

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
});
