import { describe, expect, it } from "vitest";
import {
  compileLinearPattern,
  MAX_PATTERN_INPUT,
  MAX_PATTERN_REPEAT,
  MAX_PATTERN_SOURCE,
  UnsupportedPatternError,
} from "./regex.js";

/**
 * The linear matcher replaces the host `RegExp` for catalog `pattern` values, so its
 * semantics have to agree with `RegExp` (the differential corpus below) *and* it has to stay
 * linear where `RegExp` is exponential (the ReDoS block at the end).
 */

// Patterns representative of what catalogs and `.pkey/schema` files actually carry, plus the
// syntax corners that are easy to get wrong.
const CORPUS = [
  "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z-.]+)?(?:\\+[0-9A-Za-z-.]+)?$", // djdl app.minVersion
  "^[a-z]+$",
  "abc",
  "^abc$",
  "a|b",
  "^(foo|bar|baz)$",
  "a*b",
  "a+b?c",
  "[^abc]+",
  "\\d{2,4}",
  "\\d{3}",
  "x{0,3}y",
  ".",
  "^.*$",
  "[a-z0-9_-]{3,16}",
  "^https?://",
  "\\s+",
  "\\w\\W\\s\\S\\d\\D",
  "^$",
  "(a)(b)(c)",
  "(?:ab)+",
  "[.]",
  "\\.",
  "^v?\\d+$",
  "[\\]]",
  "[a-]",
  "colou?r",
  "^(?:[A-Z][a-z]*\\s?)+$",
  "e{1,2}",
  "^[\\w.-]+@[\\w-]+\\.[a-z]{2,}$",
  "\\u0041+",
  "\\x41\\x42",
  "(a|b)*c",
  "^-?\\d+(\\.\\d+)?$",
  "^(?<major>\\d+)$",
  "[\\u00e0-\\u00ff]+",
];

const INPUTS = [
  "",
  "a",
  "ab",
  "abc",
  "abcd",
  "1.2.3",
  "1.2.3-beta.1",
  "1.2.3+build.5",
  "1.2.3-rc.1+meta",
  "x1.2.3",
  "1.2",
  "foo",
  "bar",
  "foobar",
  "aaa",
  "aaab",
  "b",
  "123",
  "12",
  "12345",
  "xxxy",
  "hello world",
  "https://x.example/a",
  "http://x",
  "  \t ",
  "Hello World",
  "user.name-1@ex-ample.com",
  "AB",
  "-42",
  "-42.5",
  "42.",
  "colour",
  "color",
  "]",
  "a-",
  "v12",
  "e",
  "ee",
  "eee",
  "café",
  "àÿ",
];

describe("compileLinearPattern — agrees with the host RegExp", () => {
  it.each(CORPUS)("matches RegExp(%j, 'u') on every corpus input", (source) => {
    const native = new RegExp(source, "u");
    const linear = compileLinearPattern(source);
    for (const input of INPUTS)
      expect({ input, hit: linear.test(input) }).toEqual({
        input,
        hit: native.test(input),
      });
  });

  it("is unanchored, like JSON Schema `pattern`", () => {
    expect(compileLinearPattern("bc").test("abcd")).toBe(true);
    expect(compileLinearPattern("^bc").test("abcd")).toBe(false);
    expect(compileLinearPattern("^abcd$").test("abcd")).toBe(true);
  });

  it("counts astral characters as single code points", () => {
    expect(compileLinearPattern("^.$").test("\u{1F44D}")).toBe(true);
    expect(new RegExp("^.$", "u").test("\u{1F44D}")).toBe(true);
  });

  it("`.` does not cross a line terminator", () => {
    expect(compileLinearPattern("^a.b$").test("a\nb")).toBe(false);
    expect(compileLinearPattern("^a.b$").test("axb")).toBe(true);
  });
});

describe("compileLinearPattern — refuses what it cannot match linearly", () => {
  const REJECTED: [string, RegExp][] = [
    ["(a)\\1", /backreference/i],
    ["(?=foo)bar", /lookahead/i],
    ["(?!foo)bar", /lookahead/i],
    ["(?<=a)b", /lookbehind/i],
    ["\\bword\\b", /word boundar/i],
    ["\\p{L}+", /property escape/i],
    [`a{0,${MAX_PATTERN_REPEAT + 1}}`, /exceeds the/i],
    ["(", /unbalanced/i],
    ["[a-", /unterminated/i],
    ["a)", /unbalanced/i],
    ["*a", /nothing to repeat/i],
  ];

  it.each(REJECTED)("rejects %j", (source, message) => {
    expect(() => compileLinearPattern(source)).toThrow(UnsupportedPatternError);
    expect(() => compileLinearPattern(source)).toThrow(message);
  });

  it("rejects an over-long source", () => {
    const long = "a".repeat(MAX_PATTERN_SOURCE + 1);
    expect(() => compileLinearPattern(long)).toThrow(/exceeds the/);
  });

  it("rejects a pattern that expands past the instruction budget", () => {
    // Nested bounded repetition is the one way a short source becomes a huge program.
    expect(() => compileLinearPattern("(?:(?:(?:a{100}){100}){100})")).toThrow(
      /instruction budget/,
    );
  });

  it("rejects nested empty-body `{n}` repeats, in bounded time", () => {
    // A6-03: `(?:)` emits no instructions, so a budget charged only on emission never fires
    // while the expansion still recurses — five nested `{100}`s is 10^10 traversals of a
    // zero-instruction program. Compilation has to refuse it, and refuse it *fast*: the
    // point of the finding is compile-time cost, which no assertion on the throw can see.
    const bomb = "(?:(?:(?:(?:(?:){100}){100}){100}){100}){100}";
    const t0 = performance.now();
    expect(() => compileLinearPattern(bomb)).toThrow(UnsupportedPatternError);
    expect(() => compileLinearPattern(bomb)).toThrow(/instruction budget/);
    // Two compiles of a 2000-step budget are microseconds; 1s is pure CI slack.
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("charges traversal cheaply enough that real patterns still compile", () => {
    // The guard rejects runaway expansion, not ordinary bounded repetition. A pattern that
    // expands to ~1200 charged steps — far more than any catalog `pattern` carries — must
    // still compile and still match.
    const big = compileLinearPattern("^(?:[a-z]{100}){4}$");
    expect(big.test("a".repeat(400))).toBe(true);
    expect(big.test("a".repeat(399))).toBe(false);
    // An empty body is legal input, not an attack, as long as it does not nest.
    expect(compileLinearPattern("^(?:){3}$").test("")).toBe(true);
    expect(new RegExp("^(?:){3}$", "u").test("")).toBe(true);
  });
});

describe("compileLinearPattern — ReDoS (R10-09 knock-on)", () => {
  /** Milliseconds to test `pattern` against `n` copies of `char`. */
  function time(source: string, char: string, n: number): number {
    const re = compileLinearPattern(source);
    const input = char.repeat(n);
    const t0 = Date.now();
    re.test(input);
    return Date.now() - t0;
  }

  it("`(x+x+)+y` — 8 chars, measured at 57s/34 chars under a backtracking engine", () => {
    // Every one of these is exponential for `RegExp`; the last is ~10^1200 steps.
    expect(time("(x+x+)+y", "x", 34)).toBeLessThan(250);
    expect(time("(x+x+)+y", "x", 40)).toBeLessThan(250);
    expect(time("(x+x+)+y", "x", 4000)).toBeLessThan(250);
  }, 30_000);

  it("`(a|a)*` — the ambiguous-alternation bomb star-height analysis misses", () => {
    expect(time("^(a|a)*b$", "a", 40)).toBeLessThan(250);
    expect(time("^(a|a)*b$", "a", 4000)).toBeLessThan(250);
  }, 30_000);

  it("`a*a*a*a*b` — polynomial rather than exponential, still capped", () => {
    expect(time("^a*a*a*a*b$", "a", 4000)).toBeLessThan(250);
  }, 30_000);

  it("`(a+)+$` against a non-matching tail", () => {
    expect(time("^(a+)+$", "a", 4000)).toBeLessThan(250);
  }, 30_000);

  it("caps the matched input and fails closed past the cap", () => {
    const re = compileLinearPattern("^a*$");
    expect(re.test("a".repeat(MAX_PATTERN_INPUT))).toBe(true);
    // Past the cap the answer is "no match" — never "skip the check".
    expect(re.test("a".repeat(MAX_PATTERN_INPUT + 1))).toBe(false);
  });

  it("stays linear: 10x the input costs far less than 10^2 the time", () => {
    const small = Math.max(time("^(x+x+)+y$", "x", 400), 1);
    const large = time("^(x+x+)+y$", "x", 4000);
    expect(large).toBeLessThan(small * 100);
  }, 30_000);
});
