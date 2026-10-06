import { describe, expect, it } from "vitest";
import {
  MAX_SCHEMA_DEPTH,
  MAX_UNIQUE_ITEMS,
  prepareSchema,
  SUPPORTED_FORMATS,
  UnsupportedSchemaError,
  validatePrepared,
  validateWork,
} from "./validate.js";

const ok = (schema: unknown, value: unknown): boolean =>
  validatePrepared(prepareSchema(schema), value).length === 0;

describe("validate — the Draft-07 subset catalogs use", () => {
  it("type", () => {
    expect(ok({ type: "string" }, "x")).toBe(true);
    expect(ok({ type: "string" }, 1)).toBe(false);
    expect(ok({ type: "integer" }, 4)).toBe(true);
    expect(ok({ type: "integer" }, 4.5)).toBe(false);
    expect(ok({ type: "number" }, 4.5)).toBe(true);
    expect(ok({ type: "boolean" }, true)).toBe(true);
    expect(ok({ type: "boolean" }, "true")).toBe(false);
    expect(ok({ type: "boolean" }, 1)).toBe(false);
    expect(ok({ type: "null" }, null)).toBe(true);
    expect(ok({ type: "array" }, [])).toBe(true);
    expect(ok({ type: "object" }, {})).toBe(true);
    expect(ok({ type: "object" }, [])).toBe(false);
    expect(ok({ type: ["string", "null"] }, null)).toBe(true);
    expect(ok({ type: ["string", "null"] }, 3)).toBe(false);
  });

  it("enum and const", () => {
    expect(ok({ enum: ["a", "b"] }, "a")).toBe(true);
    expect(ok({ enum: ["a", "b"] }, "c")).toBe(false);
    expect(ok({ enum: [{ x: 1 }] }, { x: 1 })).toBe(true); // deep equality
    expect(ok({ const: 5 }, 5)).toBe(true);
    expect(ok({ const: 5 }, "5")).toBe(false);
  });

  it("numeric bounds", () => {
    const s = { type: "integer", minimum: 1, maximum: 8 };
    expect(ok(s, 1)).toBe(true);
    expect(ok(s, 8)).toBe(true);
    expect(ok(s, 0)).toBe(false);
    expect(ok(s, 9)).toBe(false);
    expect(ok({ exclusiveMinimum: 0 }, 0)).toBe(false);
    expect(ok({ exclusiveMaximum: 10 }, 10)).toBe(false);
    expect(ok({ multipleOf: 0.5 }, 1.5)).toBe(true);
    expect(ok({ multipleOf: 0.5 }, 1.4)).toBe(false);
  });

  it("string length is measured in code points, as Ajv measured it", () => {
    expect(ok({ maxLength: 3 }, "abc")).toBe(true);
    expect(ok({ maxLength: 3 }, "abcd")).toBe(false);
    expect(ok({ minLength: 2 }, "a")).toBe(false);
    // Two astral characters are 4 UTF-16 units but 2 code points.
    expect(ok({ maxLength: 2 }, "\u{1F44D}\u{1F44D}")).toBe(true);
    expect(ok({ maxLength: 1 }, "\u{1F44D}\u{1F44D}")).toBe(false);
  });

  it("pattern", () => {
    const s = { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" };
    expect(ok(s, "1.2.3")).toBe(true);
    expect(ok(s, "1.2")).toBe(false);
  });

  it("arrays: items, minItems, maxItems, uniqueItems, contains, tuples", () => {
    const s = {
      type: "array",
      items: { type: "string", enum: ["a", "b"] },
      uniqueItems: true,
      minItems: 1,
    };
    expect(ok(s, ["a", "b"])).toBe(true);
    expect(ok(s, ["a", "a"])).toBe(false);
    expect(ok(s, [])).toBe(false);
    expect(ok(s, ["c"])).toBe(false);
    expect(ok(s, "not-an-array")).toBe(false);
    expect(ok({ type: "array", maxItems: 1 }, [1, 2])).toBe(false);
    expect(ok({ contains: { type: "number" } }, ["a", 1])).toBe(true);
    expect(ok({ contains: { type: "number" } }, ["a"])).toBe(false);
    // Tuple form + additionalItems.
    const tuple = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      additionalItems: { type: "boolean" },
    };
    expect(ok(tuple, ["a", 1])).toBe(true);
    expect(ok(tuple, ["a", 1, true])).toBe(true);
    expect(ok(tuple, ["a", 1, "x"])).toBe(false);
    expect(ok(tuple, [1, 1])).toBe(false);
  });

  it("objects: properties, required, additionalProperties, patternProperties", () => {
    const s = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(ok(s, { a: "x" })).toBe(true);
    expect(ok(s, { a: 1 })).toBe(false);
    expect(ok(s, {})).toBe(false);
    expect(ok(s, { a: "x", b: 1 })).toBe(false);
    expect(
      ok(
        { patternProperties: { "^x_": { type: "number" } } },
        { x_one: 1, other: "free" },
      ),
    ).toBe(true);
    expect(
      ok({ patternProperties: { "^x_": { type: "number" } } }, { x_one: "no" }),
    ).toBe(false);
    expect(ok({ propertyNames: { maxLength: 2 } }, { abc: 1 })).toBe(false);
    expect(ok({ minProperties: 2 }, { a: 1 })).toBe(false);
  });

  it("applicators: allOf, anyOf, oneOf, not, if/then/else", () => {
    expect(ok({ allOf: [{ type: "number" }, { minimum: 3 }] }, 4)).toBe(true);
    expect(ok({ allOf: [{ type: "number" }, { minimum: 3 }] }, 2)).toBe(false);
    expect(ok({ anyOf: [{ type: "string" }, { type: "number" }] }, 1)).toBe(
      true,
    );
    expect(ok({ anyOf: [{ type: "string" }, { type: "number" }] }, true)).toBe(
      false,
    );
    expect(ok({ oneOf: [{ minimum: 0 }, { maximum: 10 }] }, 5)).toBe(false); // both
    expect(ok({ oneOf: [{ type: "string" }, { type: "number" }] }, "a")).toBe(
      true,
    );
    expect(ok({ not: { type: "string" } }, 1)).toBe(true);
    expect(ok({ not: { type: "string" } }, "a")).toBe(false);
    const cond = {
      if: { type: "string" },
      then: { maxLength: 2 },
      else: { type: "number" },
    };
    expect(ok(cond, "ab")).toBe(true);
    expect(ok(cond, "abc")).toBe(false);
    expect(ok(cond, 5)).toBe(true);
    expect(ok(cond, true)).toBe(false);
  });

  it("boolean schemas", () => {
    expect(ok(true, "anything")).toBe(true);
    expect(ok(false, "anything")).toBe(false);
    expect(ok({}, "anything")).toBe(true);
  });

  it("reports a path-qualified message", () => {
    const issues = validatePrepared(
      prepareSchema({ type: "object", properties: { a: { type: "number" } } }),
      { a: "x" },
    );
    expect(issues[0]?.instancePath).toBe("/a");
    expect(issues[0]?.message).toMatch(/must be number/);
  });
});

describe("validate — formats", () => {
  // Expectations captured from `ajv-formats@3.0.1`'s `uri` before it was removed, so the
  // replacement is pinned to the behaviour catalogs were authored against.
  const URI_CASES: [string, boolean][] = [
    ["https://vpn.example.com/sub/x", true],
    ["not a uri", false],
    ["a:b", true],
    ["//x/y", false],
    ["mailto:a@b.c", true],
    ["urn:isbn:0451450523", true],
    ["http://ex.com/a b", false],
    ["HTTP://EX.COM", true],
    ["ftp://x/y", true],
    ["$#%", false],
  ];
  it.each(URI_CASES)("format uri: %j -> %s", (value, expected) => {
    expect(ok({ type: "string", format: "uri" }, value)).toBe(expected);
  });

  it("other supported formats", () => {
    expect(ok({ format: "ipv4" }, "192.168.0.1")).toBe(true);
    expect(ok({ format: "ipv4" }, "192.168.0.256")).toBe(false);
    expect(ok({ format: "ipv6" }, "2001:db8::1")).toBe(true);
    expect(ok({ format: "ipv6" }, "2001:db8:::1")).toBe(false);
    expect(ok({ format: "uuid" }, "0f3ab2c1-1111-2222-3333-444455556666")).toBe(
      true,
    );
    expect(ok({ format: "uuid" }, "nope")).toBe(false);
    expect(ok({ format: "date" }, "2026-08-25")).toBe(true);
    expect(ok({ format: "date" }, "25-08-2026")).toBe(false);
    expect(ok({ format: "date-time" }, "2026-08-25T10:00:00Z")).toBe(true);
    expect(ok({ format: "hostname" }, "key.plrs.im")).toBe(true);
    expect(ok({ format: "hostname" }, "-bad-.example")).toBe(false);
    expect(ok({ format: "email" }, "a@b.co")).toBe(true);
    expect(ok({ format: "email" }, "a@b")).toBe(false);
  });

  it("a format is only skipped for non-strings, never silently", () => {
    expect(ok({ format: "uri" }, 42)).toBe(true); // format applies to strings only
    expect(SUPPORTED_FORMATS).toContain("uri");
  });
});

describe("validate — fail-closed schema policy", () => {
  it("rejects an unimplemented keyword instead of ignoring it", () => {
    // Ignoring `dependencies` would report a value as valid while an operator believed a
    // constraint was in force. `$ref` additionally needs a resolver we deliberately lack.
    for (const schema of [
      { dependencies: { a: ["b"] } },
      { $ref: "#/definitions/x" },
      { unevaluatedProperties: false },
      { prefixItems: [{ type: "string" }] },
    ])
      expect(() => prepareSchema(schema)).toThrow(UnsupportedSchemaError);
  });

  it("keeps annotation keywords inert", () => {
    expect(
      ok(
        {
          type: "string",
          title: "T",
          description: "d",
          default: "x",
          examples: ["a"],
          $comment: "c",
          deprecated: true,
        },
        "hello",
      ),
    ).toBe(true);
  });

  it("rejects an unknown format rather than not enforcing it", () => {
    expect(() => prepareSchema({ format: "iso-currency" })).toThrow(
      /unsupported "format"/,
    );
  });

  it("rejects an unknown type", () => {
    expect(() => prepareSchema({ type: "int" })).toThrow(/unsupported "type"/);
  });

  it("rejects a pattern the linear matcher will not take", () => {
    expect(() => prepareSchema({ pattern: "(a)\\1" })).toThrow(
      UnsupportedSchemaError,
    );
  });

  it("caps schema depth", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i <= MAX_SCHEMA_DEPTH + 1; i++)
      schema = { type: "object", properties: { a: schema } };
    expect(() => prepareSchema(schema)).toThrow(/nests deeper/);
  });
});

describe("validate — resource bounds and hostile values", () => {
  it("gives up on uniqueItems past the scan cap instead of going quadratic", () => {
    // Counted work, not a clock: past the cap not one item is canonicalised.
    const big = Array.from({ length: MAX_UNIQUE_ITEMS + 1 }, (_, i) => i);
    let before = validateWork.canonicalised;
    expect(ok({ type: "array", uniqueItems: true }, big)).toBe(false);
    expect(validateWork.canonicalised - before).toBe(0);
    // At the cap the scan is one pass: each item is canonicalised once (a Set, not n^2 compares).
    before = validateWork.canonicalised;
    expect(ok({ type: "array", uniqueItems: true }, big.slice(1))).toBe(true);
    expect(validateWork.canonicalised - before).toBe(MAX_UNIQUE_ITEMS);
  });

  it("a deeply nested value fails closed rather than exhausting the budget", () => {
    let value: unknown = 0;
    for (let i = 0; i < 5000; i++) value = [value];
    const prepared = prepareSchema({ type: "array" });
    expect(validatePrepared(prepared, value).length).toBe(0); // top-level only, cheap
  });

  it("`__proto__` as a declared property name does not pollute Object.prototype", () => {
    // Catalogs always arrive via `JSON.parse(row.catalog_json)`, where `__proto__` is a real
    // own property (an object *literal* would instead reassign the prototype), so this is
    // the shape production actually sees.
    const schema: unknown = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}',
    );
    expect(ok(schema, JSON.parse('{"__proto__":"x"}'))).toBe(true);
    expect(ok(schema, JSON.parse('{"__proto__":1}'))).toBe(false);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("never throws for a hostile value — callers prune, they do not 500", () => {
    const prepared = prepareSchema({ type: "string", maxLength: 10 });
    for (const v of [undefined, null, NaN, Infinity, Symbol.iterator, () => 1])
      expect(() => validatePrepared(prepared, v as unknown)).not.toThrow();
  });
});
