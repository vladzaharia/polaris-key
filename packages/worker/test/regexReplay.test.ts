/**
 * The step-counting replay engine the ReDoS checks rest on (test/regexReplay.ts): it must agree
 * with `RegExp` on what matches, see every native run through `test`, `replace`, `split` and
 * `match`, count linear patterns as linear, and count catastrophic backtracking as such.
 */

import { describe, expect, it } from "vitest";
import { recordRegexRuns, regexSteps, replaySteps } from "./regexReplay.js";

const CORPUS: Array<[string, string, string[]]> = [
  [
    "<!--[ \\t\\r\\n]*pkey:summary[ \\t\\r\\n]*-->",
    "",
    [
      "<!-- pkey:summary -->",
      "x<!--\npkey:summary-->",
      "<!-- pkey:summ -->",
      "",
    ],
  ],
  [
    "\\[([^\\]\\n]{1,200})\\]\\([^)\\n]{0,500}\\)",
    "g",
    ["[a](b)", "[](x)", "[a]\n(b)", "x[ab](c)y", "[a](b"],
  ],
  ["^[ \\t]*[-*+][ \\t]+", "gm", ["- a", "  * b", "x\n+ c", "-x", "\t-\tx"]],
  ["^##[ \\t]", "m", ["## a", "x\n## b", "### c", "##"]],
  ["\\n[ \\t\\r]*\\n", "", ["a\n\nb", "a\n \t\nb", "a\nb"]],
  ["^(?:(x+x+)+y)$", "", ["xxy", "xxxxy", "xy", "xxxx"]],
  ["a|bc|", "", ["", "bc", "zz"]],
  ["\\bfoo\\B", "", ["foobar", "foo", "a foox"]],
  ["[^]x|[]", "", ["ax", "x"]],
  ["\\d{2,3}?\\w*?z", "", ["123z", "12z", "1z", "12345z"]],
];

describe("regexReplay", () => {
  it("agrees with RegExp on what matches", () => {
    for (const [source, flags, inputs] of CORPUS)
      for (const input of inputs)
        expect({
          source,
          input,
          hit: regexSteps(source, flags, input).matched,
        }).toEqual({
          source,
          input,
          hit: new RegExp(source, flags).test(input),
        });
  });

  it("records the runs test, replace, split and match make, then restores exec", () => {
    const exec = RegExp.prototype.exec;
    const { result, runs } = recordRegexRuns(() => [
      /b/.test("abc"),
      "a-b-c".replace(/-/g, "+"),
      "a1b2c".split(/\d/),
      "xyz".match(/y/)?.[0],
    ]);
    expect(result).toEqual([true, "a+b+c", ["a", "b", "c"], "y"]);
    expect(new Set(runs.map((r) => r.source))).toEqual(
      new Set(["b", "-", "\\d", "y"]),
    );
    expect(RegExp.prototype.exec).toBe(exec);
    expect(replaySteps(runs)).toBeGreaterThan(0);
  });

  it("counts a linear pattern linearly and a backtracking bomb exponentially", () => {
    const linear = (n: number) =>
      regexSteps("^[ \\t]*[-*+][ \\t]+", "gm", " ".repeat(n)).steps;
    expect(linear(4000)).toBeLessThanOrEqual(4.4 * linear(1000));
    const bomb = (n: number) =>
      regexSteps("^(?:(x+x+)+y)$", "", "x".repeat(n)).steps;
    expect(bomb(16)).toBeGreaterThan(16 * bomb(10));
  });

  it("refuses syntax it does not model rather than counting nothing", () => {
    for (const source of ["(?=a)b", "(a)\\1", "(a*)*", "a{2"])
      expect(() => regexSteps(source, "", "aa")).toThrow(/regexReplay/);
    expect(() => regexSteps("a", "i", "A")).toThrow(/flags/);
  });
});
