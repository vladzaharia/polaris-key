// Unit tests for the environment-value rule (WIRE-CONTRACT-V3 §2.2.1 rule 2) helpers and the
// own-property reads. The corpus rows (`config-matrix.json`) run in
// conformance/runners/node/configMatrix.test.ts; these cover what no corpus row can carry.
import { describe, expect, it } from "vitest";
import {
  hasLoneSurrogate,
  listUserEntries,
  nestingExceeds,
  numberTokenInRange,
  numbersInRange,
  parseEnvValue,
  resolveSource,
  resolveValue,
  type ResolveContext,
} from "../src/config.js";

describe("numberTokenInRange", () => {
  it("accepts both sides of each edge that is in range", () => {
    for (const token of [
      "9.99e307",
      "1e307",
      "1e-307",
      "0.1e-306",
      "10e306",
      "0",
      "-0",
      "0e5",
      "0e999999",
      "1e0000001",
      "123456789012345678901234567890",
    ])
      expect(numberTokenInRange(token), token).toBe(true);
  });

  it("refuses both sides of each edge that is out of range", () => {
    for (const token of [
      "1e308",
      "10e307",
      "1.7976931348623158e308",
      "1e-308",
      "0.1e-307",
      "5e-324",
      "1e400",
      "-1e400",
      "1" + "0".repeat(308),
      "0e1000000",
      "1e4294967297",
    ])
      expect(numberTokenInRange(token), token).toBe(false);
  });

  it("never throws on a malformed run", () => {
    for (const token of [
      "1e5-5",
      "-",
      "--",
      "1..2",
      "1e",
      "1e+",
      "e5",
      "+",
      "1-2-3",
      "0x10",
      "1ee5",
    ])
      expect(() => numberTokenInRange(token)).not.toThrow();
  });
});

describe("numbersInRange", () => {
  it("skips numbers inside strings, escaped quotes included", () => {
    expect(numbersInRange('["1e400"]')).toBe(true);
    expect(numbersInRange('["\\"1e400"]')).toBe(true);
    expect(numbersInRange('{"a":[1e400]}')).toBe(false);
  });
});

describe("nestingExceeds", () => {
  it("counts arrays and objects, not brackets inside strings", () => {
    expect(nestingExceeds("[".repeat(64) + "]".repeat(64), 64)).toBe(false);
    expect(nestingExceeds("[".repeat(65) + "]".repeat(65), 64)).toBe(true);
    expect(nestingExceeds('["' + "[".repeat(100) + '"]', 64)).toBe(false);
  });
});

describe("hasLoneSurrogate", () => {
  // The ten strings the plan measured against `!s.isWellFormed()` on Node 22.13.
  const cases: [string, boolean][] = [
    ["😀", false],
    ["\ud800x", true],
    ["x\ud800", true],
    ["\udc00x", true],
    ["x\udc00", true],
    ["\ude00\ud83d", true],
    ["😀\ude00", true],
    ["\ud800𐀀", true],
    ["", false],
    ["plain text", false],
  ];
  for (const [s, lone] of cases)
    it(`${JSON.stringify(s)} -> ${lone}`, () =>
      expect(hasLoneSurrogate(s)).toBe(lone));
});

describe("parseEnvValue", () => {
  it("keeps a raw lone surrogate raw (no corpus row can carry one)", () => {
    const raw = '["' + String.fromCharCode(0xd800) + '"]';
    expect(parseEnvValue(raw)).toBe(raw);
  });

  it("returns a 120,000-character text unchanged without throwing", () => {
    const raw = "[".repeat(60_000) + "]".repeat(60_000);
    expect(parseEnvValue(raw)).toBe(raw);
  });
});

describe("own-property reads", () => {
  const ctx = (over: Partial<ResolveContext> = {}): ResolveContext => ({
    remote: {},
    localOverrides: {},
    env: {},
    envPrefix: "",
    ...over,
  });

  it("a key named after an Object.prototype member is an ordinary key", () => {
    expect(resolveValue(ctx(), "constructor")).toBeUndefined();
    expect(resolveSource(ctx(), "constructor")).toBe("fallback");
    expect(resolveSource(ctx(), "toString")).toBe("fallback");
    expect(resolveSource(ctx({ remote: undefined }), "valueOf")).toBe(
      "fallback",
    );
  });

  it("lists document entries only, each with its resolved value", () => {
    const listed = listUserEntries(
      ctx({
        remote: {
          a: { state: "default", value: 1, updatedAt: 1 },
          h: { state: "hidden", value: 2, updatedAt: 1 },
        },
        localOverrides: { a: 9, z: "local" },
      }),
    );
    expect(listed).toEqual([{ key: "a", value: 9, enforced: false }]);
  });
});
