// plans/P3-01.md §2.2: one function decides whether an operator value can ride inside a signed
// document every wire-v4 verifier accepts, and `validateEntryValue` runs it first.
import { describe, expect, it } from "vitest";
import {
  MAX_VALUE_DEPTH,
  catalogKeyIssue,
  numberInWireRange,
  representabilityIssue,
} from "./representable.js";
import { Catalog } from "./catalog.js";

function nested(levels: number): unknown {
  let v: unknown = {};
  for (let k = 1; k < levels; k++) v = { x: v };
  return v;
}

function nestedArrays(levels: number): unknown {
  let v: unknown = [];
  for (let k = 1; k < levels; k++) v = [v];
  return v;
}

describe("representabilityIssue", () => {
  const flagged: [string, unknown, string, string][] = [
    ["a lone high surrogate", "\ud800", "lone-surrogate", ""],
    ["a lone low surrogate", "a\udc00", "lone-surrogate", ""],
    ["a reversed pair", "\udc00\ud800", "lone-surrogate", ""],
    [
      "a lone surrogate deep in an array",
      { a: [1, "x\ud800"] },
      "lone-surrogate",
      "/a/1",
    ],
    [
      "a lone surrogate in a member name",
      { "\ud800": 1 },
      "lone-surrogate",
      "/\ud800",
    ],
    [
      "U+0000 in a member name",
      { "a\u0000b": 1 },
      "nul-in-member-name",
      "/a\u0000b",
    ],
    [
      "canonically equivalent sibling names",
      { "\u00e9": 1, "e\u0301": 2 },
      "equivalent-member-names",
      "/e\u0301",
    ],
    ["1e-320", 1e-320, "number-out-of-range", ""],
    ["5e-324", { n: [5e-324] }, "number-out-of-range", "/n/0"],
    ["9.99e-308", 9.99e-308, "number-out-of-range", ""],
    ["Number.MAX_VALUE", Number.MAX_VALUE, "number-out-of-range", ""],
    ["Infinity", Infinity, "number-out-of-range", ""],
    ["NaN", NaN, "number-out-of-range", ""],
    [
      `${MAX_VALUE_DEPTH + 1} object levels`,
      nested(MAX_VALUE_DEPTH + 1),
      "too-deep",
      "/x".repeat(MAX_VALUE_DEPTH),
    ],
    [
      `${MAX_VALUE_DEPTH + 1} array levels`,
      nestedArrays(MAX_VALUE_DEPTH + 1),
      "too-deep",
      "/0".repeat(MAX_VALUE_DEPTH),
    ],
    [
      "a member name with / and ~ in the pointer",
      { "a/b~": "\ud800" },
      "lone-surrogate",
      "/a~1b~0",
    ],
  ];
  for (const [name, value, rule, path] of flagged) {
    it(`flags ${name}`, () => {
      expect(representabilityIssue(value)).toEqual({ rule, path });
    });
  }

  const clean: [string, unknown][] = [
    ["a surrogate pair", "😀"],
    ["U+0000 in a value", "a\u0000b"],
    [
      "the same name twice under different parents",
      { a: { é: 1 }, b: { é: 2 } },
    ],
    ["1e-307", 1e-307],
    ["9.99e307", 9.99e307],
    ["zero and negative zero", [0, -0]],
    ["a fraction", 1700000000.5],
    ["2^53", 2 ** 53],
    [`exactly ${MAX_VALUE_DEPTH} levels`, nested(MAX_VALUE_DEPTH)],
    ["null, booleans and the empty containers", [null, true, false, {}, []]],
  ];
  for (const [name, value] of clean) {
    it(`accepts ${name}`, () => {
      expect(representabilityIssue(value)).toBeNull();
    });
  }

  it("stops at the depth limit instead of recursing through a hostile value", () => {
    expect(representabilityIssue(nested(100_000))?.rule).toBe("too-deep");
  });
});

describe("numberInWireRange agrees with the token JSON.stringify writes", () => {
  for (const [n, ok] of [
    [1e-307, true],
    [1e-308, false],
    [9.99e307, true],
    [1e308, false],
    [-1e-307, true],
    [-1e308, false],
    [123.456, true],
    [1e21, true],
  ] as const) {
    it(`${JSON.stringify(n)} → ${ok}`, () => {
      expect(numberInWireRange(n)).toBe(ok);
    });
  }
});

describe("validateEntryValue runs representability first", () => {
  const catalog = new Catalog({
    schemaVersion: 1,
    entries: [
      {
        key: "app.blob",
        kind: "config",
        category: "General",
        label: "Blob",
        schema: { type: "object" },
        managementDefault: "default",
      },
      {
        key: "app.name",
        kind: "config",
        category: "General",
        label: "Name",
        schema: { type: "string" },
        managementDefault: "default",
      },
    ],
  } as never);

  it("refuses an object value the schema alone would accept, naming the rule", () => {
    const res = catalog.validateKeyValue("app.blob", { "a\u0000b": 1 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.representability).toEqual({
      rule: "nul-in-member-name",
      path: "/a\u0000b",
    });
    expect(res.errors[0]).toContain("app.blob");
    expect(res.errors[0]).toContain("nul-in-member-name");
  });

  it("refuses a lone surrogate in a string value", () => {
    const res = catalog.validateKeyValue("app.name", "\ud800");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.representability?.rule).toBe("lone-surrogate");
  });

  it("reports a schema failure without a representability issue", () => {
    const res = catalog.validateKeyValue("app.name", 7);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.representability).toBeUndefined();
  });

  it("accepts a clean value", () => {
    expect(catalog.validateKeyValue("app.blob", { é: 1 }).ok).toBe(true);
  });
});

describe("catalogKeyIssue: catalog keys are member names in the documents", () => {
  const nfc = "\u00e9";
  const nfd = "e\u0301";
  const entry = (key: string, kind = "config") => ({
    key,
    kind,
    schema: { type: "string" },
    default: "x",
  });

  it("a walk of the catalog as a value misses what the projection catches", () => {
    const pair = { entries: [entry(nfc), entry(nfd)] };
    expect(representabilityIssue(pair)).toBeNull();
    expect(catalogKeyIssue(pair)).toEqual({
      rule: "equivalent-member-names",
      path: "/entries/1/key",
    });
    const nul = { entries: [entry("a\u0000b")] };
    expect(representabilityIssue(nul)).toBeNull();
    expect(catalogKeyIssue(nul)).toEqual({
      rule: "nul-in-member-name",
      path: "/entries/0/key",
    });
  });

  it("flags a lone surrogate in a key", () => {
    expect(
      catalogKeyIssue({ entries: [entry("ok"), entry("a\ud800")] }),
    ).toEqual({ rule: "lone-surrogate", path: "/entries/1/key" });
  });

  it("NFC-equivalent keys of different kinds land in different objects", () => {
    expect(
      catalogKeyIssue({ entries: [entry(nfc), entry(nfd, "secret")] }),
    ).toBeNull();
    expect(
      catalogKeyIssue({ entries: [entry(nfc, "flag"), entry(nfd, "flag")] }),
    ).toEqual({ rule: "equivalent-member-names", path: "/entries/1/key" });
  });

  it("accepts ordinary keys, an identical repeat, and shapes that are not a catalog", () => {
    expect(
      catalogKeyIssue({ entries: [entry("ui.theme"), entry("a:b-c_d")] }),
    ).toBeNull();
    expect(catalogKeyIssue({ entries: [entry(nfc), entry(nfc)] })).toBeNull();
    expect(catalogKeyIssue(null)).toBeNull();
    expect(catalogKeyIssue({ entries: "x" })).toBeNull();
    expect(catalogKeyIssue({ entries: [null, { key: 3 }] })).toBeNull();
  });
});
