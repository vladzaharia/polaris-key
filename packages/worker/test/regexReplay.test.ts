/**
 * The step-counting replay engine the ReDoS checks rest on (test/regexReplay.ts): it must agree
 * with `RegExp` on where a match is and what it captures, see every native run through `test`,
 * `replace`, `split` and `match`, count linear patterns as linear, and count catastrophic
 * backtracking as such. The corpus holds every pattern the checks actually replay (the notes
 * summary's and resolveChannel's) plus the syntax corners.
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
  [
    "<!--[ \\t\\r\\n]*\\/pkey:summary[ \\t\\r\\n]*-->",
    "",
    [
      "<!-- /pkey:summary -->",
      "x<!--\n/pkey:summary-->y",
      "<!-- pkey:summary -->",
    ],
  ],
  ["[*_`]+", "g", ["**bold**", "a_b`c", "none", "x``y", ""]],
  [
    "^[ \\t]*#{1,6}[ \\t]+",
    "gm",
    ["# a", "  ### b", "x\n## c", "####### d", "#x"],
  ],
  [
    "^pr-(\\d{1,7})$",
    "",
    ["pr-42", "pr-1234567", "pr-12345678", "pr-", "xpr-1"],
  ],
  ["^\\d+\\.\\d+\\.\\d+", "", ["1.2.3", "10.20.30-beta", "1.2", "v1.2.3"]],
  ["^v", "", ["v1.2.3", "1.2.3", ""]],
  ["^(?:(x+x+)+y)$", "", ["xxy", "xxxxy", "xy", "xxxx"]],
  ["(a|(b))+", "", ["ba", "ab", "bb", "c"]],
  ["(a)?(b)?c|(d)", "", ["bc", "ac", "c", "d"]],
  ["a|bc|", "", ["", "bc", "zz"]],
  ["\\bfoo\\B", "", ["foobar", "foo", "a foox"]],
  ["[^]x|[]", "", ["ax", "x"]],
  ["\\d{2,3}?\\w*?z", "", ["123z", "12z", "1z", "12345z"]],
];

describe("regexReplay", () => {
  it("agrees with RegExp on where each match is and what it captures", () => {
    for (const [source, flags, inputs] of CORPUS)
      for (const input of inputs) {
        const replayed = regexSteps(source, flags, input);
        const native = new RegExp(source, flags).exec(input);
        expect({
          source,
          input,
          index: replayed.index ?? null,
          captures: replayed.captures ?? null,
        }).toEqual({
          source,
          input,
          index: native?.index ?? null,
          captures: native ? [...native] : null,
        });
      }
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

  it("refuses an async fn, whose regex runs would land after the recording stopped", () => {
    const exec = RegExp.prototype.exec;
    expect(() => recordRegexRuns(async () => /a/.test("a"))).toThrow(
      /synchronous work only/,
    );
    expect(RegExp.prototype.exec).toBe(exec);
  });

  it("refuses syntax it does not model rather than counting nothing", () => {
    for (const source of ["(?=a)b", "(a)\\1", "(a*)*", "a{2"])
      expect(() => regexSteps(source, "", "aa")).toThrow(/regexReplay/);
    expect(() => regexSteps("a", "i", "A")).toThrow(/flags/);
  });
});
