import { describe, it, expect } from "vitest";
import { Catalog, type ProductCatalog } from "./index.js";
import { patternWork } from "./regex.js";
import { validateWork } from "./validate.js";

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
      managementDefault: "default",
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
    expect(catalog.entriesByKind("secret").map((e) => e.key)).toEqual([
      "proxy.subscriptionUrl",
    ]);
    expect(catalog.entriesByKind("flag").map((e) => e.key)).toEqual([
      "polarisVpn",
    ]);
    expect(catalog.categories()).toEqual(["Run", "VPN"]);
  });

  it("validates good values", () => {
    expect(catalog.validateKeyValue("run.concurrency", 4).ok).toBe(true);
    expect(
      catalog.validateKeyValue(
        "proxy.subscriptionUrl",
        "https://vpn.example.com/sub/x",
      ).ok,
    ).toBe(true);
    expect(catalog.validateKeyValue("polarisVpn", true).ok).toBe(true);
  });

  it("rejects bad values with a keyed error", () => {
    const res = catalog.validateKeyValue("run.concurrency", 99);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("run.concurrency");
  });

  it("rejects a malformed secret (not a uri)", () => {
    expect(
      catalog.validateKeyValue("proxy.subscriptionUrl", "not a url").ok,
    ).toBe(false);
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

// A catalog exercising every JSON-Schema keyword the admin form + worker validation rely
// on. Each entry is its own key so validation is isolated.
const KEYWORD_CATALOG: ProductCatalog = {
  schemaVersion: 1,
  entries: [
    {
      key: "k.enum",
      kind: "config",
      category: "C",
      label: "Enum",
      description: "",
      schema: { type: "string", enum: ["stable", "staging", "pr"] },
    },
    {
      key: "k.int",
      kind: "config",
      category: "C",
      label: "Integer",
      description: "",
      schema: { type: "integer", minimum: 1, maximum: 8 },
    },
    {
      key: "k.num",
      kind: "config",
      category: "C",
      label: "Number range",
      description: "",
      schema: { type: "number", minimum: 0.5, maximum: 2.5 },
    },
    {
      key: "k.uri",
      kind: "secret",
      secret: true,
      category: "C",
      label: "URI",
      description: "",
      schema: { type: "string", format: "uri", maxLength: 64 },
    },
    {
      key: "k.bool",
      kind: "flag",
      category: "C",
      label: "Boolean",
      description: "",
      schema: { type: "boolean" },
    },
    {
      key: "k.arr",
      kind: "config",
      category: "C",
      label: "Unique array",
      description: "",
      schema: {
        type: "array",
        items: { type: "string" },
        uniqueItems: true,
        minItems: 1,
      },
    },
    {
      key: "k.str",
      kind: "config",
      category: "C",
      label: "String length",
      description: "",
      schema: { type: "string", minLength: 2, maxLength: 5 },
    },
  ],
};

describe("Catalog — JSON-Schema keyword validation", () => {
  const catalog = new Catalog(KEYWORD_CATALOG);

  it("enum: accepts members, rejects non-members", () => {
    expect(catalog.validateKeyValue("k.enum", "stable").ok).toBe(true);
    expect(catalog.validateKeyValue("k.enum", "nightly").ok).toBe(false);
  });

  it("integer: rejects out-of-range and non-integers", () => {
    expect(catalog.validateKeyValue("k.int", 4).ok).toBe(true);
    expect(catalog.validateKeyValue("k.int", 0).ok).toBe(false); // < minimum
    expect(catalog.validateKeyValue("k.int", 9).ok).toBe(false); // > maximum
    expect(catalog.validateKeyValue("k.int", 4.5).ok).toBe(false); // not integer
  });

  it("number min/max: accepts within, rejects outside", () => {
    expect(catalog.validateKeyValue("k.num", 1.5).ok).toBe(true);
    expect(catalog.validateKeyValue("k.num", 0.25).ok).toBe(false);
    expect(catalog.validateKeyValue("k.num", 3).ok).toBe(false);
  });

  it("format uri + maxLength: accepts a URL, rejects garbage and over-length", () => {
    expect(
      catalog.validateKeyValue("k.uri", "https://vpn.example.com/sub").ok,
    ).toBe(true);
    expect(catalog.validateKeyValue("k.uri", "not a uri").ok).toBe(false);
    expect(
      catalog.validateKeyValue("k.uri", "https://" + "x".repeat(100)).ok,
    ).toBe(false);
  });

  it("boolean: rejects non-booleans", () => {
    expect(catalog.validateKeyValue("k.bool", true).ok).toBe(true);
    expect(catalog.validateKeyValue("k.bool", "true").ok).toBe(false);
    expect(catalog.validateKeyValue("k.bool", 1).ok).toBe(false);
  });

  it("array uniqueItems + minItems: rejects duplicates and empty arrays", () => {
    expect(catalog.validateKeyValue("k.arr", ["a", "b"]).ok).toBe(true);
    expect(catalog.validateKeyValue("k.arr", ["a", "a"]).ok).toBe(false); // not unique
    expect(catalog.validateKeyValue("k.arr", []).ok).toBe(false); // < minItems
    expect(catalog.validateKeyValue("k.arr", "not-an-array").ok).toBe(false);
  });

  it("string min/maxLength: enforces both bounds", () => {
    expect(catalog.validateKeyValue("k.str", "abc").ok).toBe(true);
    expect(catalog.validateKeyValue("k.str", "a").ok).toBe(false); // < minLength
    expect(catalog.validateKeyValue("k.str", "abcdef").ok).toBe(false); // > maxLength
  });

  it("surfaces a keyed, path-qualified error message", () => {
    const res = catalog.validateKeyValue("k.int", 99);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]).toContain("k.int");
  });
});

describe("Catalog — ordering, dependsOn, idempotency", () => {
  it("entriesByKind preserves declaration order within a kind", () => {
    const cat = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "a",
          kind: "config",
          category: "X",
          label: "",
          description: "",
          schema: { type: "string" },
        },
        {
          key: "b",
          kind: "config",
          category: "Y",
          label: "",
          description: "",
          schema: { type: "string" },
        },
        {
          key: "c",
          kind: "secret",
          category: "X",
          label: "",
          description: "",
          schema: { type: "string" },
        },
        {
          key: "d",
          kind: "config",
          category: "X",
          label: "",
          description: "",
          schema: { type: "string" },
        },
      ],
    });
    expect(cat.entriesByKind("config").map((e) => e.key)).toEqual([
      "a",
      "b",
      "d",
    ]);
    expect(cat.entriesByKind("secret").map((e) => e.key)).toEqual(["c"]);
    expect(cat.entriesByKind("flag")).toEqual([]);
  });

  it("categories() are first-seen order, de-duplicated", () => {
    const cat = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "a",
          kind: "config",
          category: "Run",
          label: "",
          description: "",
          schema: {},
        },
        {
          key: "b",
          kind: "config",
          category: "VPN",
          label: "",
          description: "",
          schema: {},
        },
        {
          key: "c",
          kind: "config",
          category: "Run",
          label: "",
          description: "",
          schema: {},
        },
        {
          key: "d",
          kind: "config",
          category: "Advanced",
          label: "",
          description: "",
          schema: {},
        },
      ],
    });
    expect(cat.categories()).toEqual(["Run", "VPN", "Advanced"]);
  });

  it("preserves the dependsOn metadata on an entry verbatim", () => {
    const cat = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "proxy.enabled",
          kind: "config",
          category: "VPN",
          label: "",
          description: "",
          schema: { type: "boolean" },
        },
        {
          key: "proxy.subscriptionUrl",
          kind: "secret",
          category: "VPN",
          label: "",
          description: "",
          schema: { type: "string", format: "uri" },
          dependsOn: { key: "proxy.enabled", equals: true },
        },
      ],
    });
    const dep = cat.entryByKey("proxy.subscriptionUrl");
    expect(dep?.dependsOn).toEqual({ key: "proxy.enabled", equals: true });
    // dependsOn is presentation metadata — it does not gate value validation.
    expect(
      cat.validateKeyValue("proxy.subscriptionUrl", "https://x.example/sub").ok,
    ).toBe(true);
  });

  it("compileAll() is idempotent — repeat calls reuse compiled validators and still validate", () => {
    const cat = new Catalog(KEYWORD_CATALOG);
    expect(() => {
      cat.compileAll();
      cat.compileAll();
    }).not.toThrow();
    // Validation still works after multiple compileAll() passes.
    expect(cat.validateKeyValue("k.enum", "pr").ok).toBe(true);
    expect(cat.validateKeyValue("k.enum", "bogus").ok).toBe(false);
  });

  it("prepares each entry's schema once, however many values it validates", () => {
    // Counted (validateWork.prepares), not timed: the console's memoised `validate` relies on
    // this, and its own test can only see that one Catalog serves every call.
    const cat = new Catalog(KEYWORD_CATALOG);
    const entry = cat.entryByKey("k.int")!;
    const before = validateWork.prepares;
    for (let i = 0; i < 2000; i++) cat.validateEntryValue(entry, i % 10);
    cat.compileAll();
    expect(validateWork.prepares - before).toBe(KEYWORD_CATALOG.entries.length);
  });

  it("validates `pattern` through the counted linear matcher: 10x the value, at most 11x the steps", () => {
    // End to end: a Catalog validation reaches the linear matcher (patternWork.steps moves) and
    // stays linear on the R10-09 bomb, where a backtracking engine costs about 2^n.
    const cat = new Catalog({
      schemaVersion: 1,
      entries: [
        {
          key: "k",
          kind: "config",
          category: "c",
          label: "l",
          description: "",
          schema: { type: "string", pattern: "(x+x+)+y" },
        },
      ],
    });
    const steps = (n: number): number => {
      const before = patternWork.steps;
      expect(cat.validateKeyValue("k", "x".repeat(n)).ok).toBe(false);
      return patternWork.steps - before;
    };
    const small = steps(400);
    const large = steps(4000);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThanOrEqual(11 * small);
  });

  it("validateEntryValue agrees with validateKeyValue for a known entry", () => {
    const cat = new Catalog(KEYWORD_CATALOG);
    const entry = cat.entryByKey("k.int")!;
    expect(cat.validateEntryValue(entry, 3).ok).toBe(true);
    expect(cat.validateEntryValue(entry, 99).ok).toBe(false);
  });

  it("exposes schemaVersion and the full entries list", () => {
    const cat = new Catalog(KEYWORD_CATALOG);
    expect(cat.schemaVersion).toBe(1);
    expect(cat.entries.length).toBe(KEYWORD_CATALOG.entries.length);
  });
});
