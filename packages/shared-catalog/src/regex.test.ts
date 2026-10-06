import { describe, expect, it } from "vitest";
import {
  compileLinearPattern,
  MAX_PATTERN_INPUT,
  MAX_PATTERN_REPEAT,
  MAX_PATTERN_PROGRAM,
  MAX_PATTERN_SOURCE,
  patternWork,
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
});

describe("compileLinearPattern — ReDoS (R10-09 knock-on)", () => {
  // Counted work (`patternWork.steps`, every NFA instruction `test` visits), never a clock, so
  // load cannot move these checks. A backtracking engine needs about 2^n steps for the bombs
  // below (`(x+x+)+y` took 57 s at 34 characters under one); this one must stay within a fixed
  // number of steps per input character.

  /** NFA steps to test `source` against `n` copies of `char`. */
  function steps(source: string, char: string, n: number): number {
    const re = compileLinearPattern(source);
    const input = char.repeat(n);
    const before = patternWork.steps;
    re.test(input);
    return patternWork.steps - before;
  }

  /** Per input position the closure and the step each visit an instruction a bounded number of
   *  times (each `split` pushes two), so no pattern the compiler accepts can cost more than this
   *  per character. Exponential backtracking blows through it within a few dozen characters. */
  const CEILING_PER_CHAR = 8 * MAX_PATTERN_PROGRAM;

  /** Linear: 10x the input costs at most 11x the steps (quadratic would be 100x, n log n 14x),
   *  and every length stays under the per-character ceiling. */
  function expectLinear(source: string, char: string): void {
    const small = steps(source, char, 400);
    const large = steps(source, char, 4000);
    expect(small).toBeGreaterThan(0);
    expect(large).toBeLessThanOrEqual(small * 11);
    for (const n of [28, 34, 40, 4000])
      expect(steps(source, char, n)).toBeLessThanOrEqual(
        CEILING_PER_CHAR * (n + 1),
      );
  }

  it("`(x+x+)+y` — 8 chars, measured at 57s/34 chars under a backtracking engine", () => {
    // Every one of these is exponential for `RegExp`; the last is ~10^1200 steps.
    expectLinear("(x+x+)+y", "x");
    // Under Ajv each extra character doubled the runtime (28 -> 40 was 4096x); here it is the
    // same cost per character.
    expect(steps("(x+x+)+y", "x", 40)).toBeLessThanOrEqual(
      2 * steps("(x+x+)+y", "x", 28),
    );
  });

  it("`(a|a)*` — the ambiguous-alternation bomb star-height analysis misses", () => {
    expectLinear("^(a|a)*b$", "a");
    // +12 characters must not multiply the cost by 4096.
    expect(steps("^(a|a)*b$", "a", 42)).toBeLessThanOrEqual(
      2 * steps("^(a|a)*b$", "a", 30),
    );
  });

  it("`a*a*a*a*b` — polynomial rather than exponential, still capped", () => {
    expectLinear("^a*a*a*a*b$", "a");
  });

  it("`(a+)+$` against a non-matching tail", () => {
    expectLinear("^(a+)+$", "a");
  });

  it("caps the matched input and fails closed past the cap", () => {
    const re = compileLinearPattern("^a*$");
    expect(re.test("a".repeat(MAX_PATTERN_INPUT))).toBe(true);
    // Past the cap the answer is "no match" — never "skip the check".
    expect(re.test("a".repeat(MAX_PATTERN_INPUT + 1))).toBe(false);
  });

  it("stays linear: 10x the input costs 10x the steps, not 10^2", () => {
    expectLinear("^(x+x+)+y$", "x");
    // Each extra character costs the same at 4,000 as at 400: a constant rate, not a growing one.
    const rate = (a: number, b: number) =>
      (steps("^(x+x+)+y$", "x", b) - steps("^(x+x+)+y$", "x", a)) / (b - a);
    expect(rate(400, 4000)).toBeLessThanOrEqual(rate(40, 400) * 1.05);
  });

  it("past the input cap no step is taken at all", () => {
    expect(steps("^[a-z]*$", "a", MAX_PATTERN_INPUT + 1)).toBe(0);
    expect(steps("^[a-z]*$", "a", 200_000)).toBe(0);
  });
});
