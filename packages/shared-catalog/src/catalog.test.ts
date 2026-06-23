import { describe, it, expect } from "vitest";
import { Catalog, type ProductCatalog } from "./index.js";

const CATALOG: ProductCatalog = {
  schemaVersion: 1,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "Run",
      label: "Parallel downloads",
      description: "How many downloads run in parallel.",
      accessor: "run.concurrency",
      schema: { type: "integer", minimum: 1, maximum: 8 },
      managementDefault: "unmanaged",
    },
    {
      key: "proxy.subscriptionUrl",
      kind: "secret",
      secret: true,
      category: "VPN",
      label: "VPN subscription URL",
      description: "Subscription URL.",
      accessor: "proxy.subscriptionUrl",
      schema: { type: "string", format: "uri", maxLength: 2048 },
      managementDefault: "hidden",
    },
    {
      key: "polarisVpn",
      kind: "flag",
      category: "VPN",
      label: "Polaris VPN",
      description: "Master VPN switch.",
      schema: { type: "boolean" },
      userGrant: true,
    },
  ],
};

describe("Catalog", () => {
  const catalog = new Catalog(CATALOG);

  it("looks up entries by key and kind", () => {
    expect(catalog.entryByKey("run.concurrency")?.kind).toBe("config");
    expect(catalog.entriesByKind("secret").map((e) => e.key)).toEqual(["proxy.subscriptionUrl"]);
    expect(catalog.entriesByKind("flag").map((e) => e.key)).toEqual(["polarisVpn"]);
    expect(catalog.categories()).toEqual(["Run", "VPN"]);
  });

  it("validates good values", () => {
    expect(catalog.validateKeyValue("run.concurrency", 4).ok).toBe(true);
    expect(catalog.validateKeyValue("proxy.subscriptionUrl", "https://vpn.example.com/sub/x").ok).toBe(true);
    expect(catalog.validateKeyValue("polarisVpn", true).ok).toBe(true);
  });

  it("rejects bad values with a keyed error", () => {
    const res = catalog.validateKeyValue("run.concurrency", 99);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("run.concurrency");
  });

  it("rejects a malformed secret (not a uri)", () => {
    expect(catalog.validateKeyValue("proxy.subscriptionUrl", "not a url").ok).toBe(false);
  });

  it("rejects unknown keys (admins assign values, never invent keys)", () => {
    const res = catalog.validateKeyValue("made.up.key", 1);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("unknown config key");
  });

  it("eager compileAll() does not throw", () => {
    expect(() => catalog.compileAll()).not.toThrow();
  });
});
