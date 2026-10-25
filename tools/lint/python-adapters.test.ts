/**
 * P0-46.4: the ruff and mypy adapters (tools/lint/adapters) over fixtures of the tools' real JSON
 * output, and through the lint-debt ledger.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as mypy } from "./adapters/mypy.mjs";
import { parse as ruff } from "./adapters/ruff.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (n: string) => readFileSync(join(FIX, n), "utf8");

describe("ruff adapter", () => {
  it("maps absolute filenames to repo-relative and prefixes the code", () => {
    expect(ruff(fixture("ruff.json"), { root: "/repo" })).toEqual([
      { file: "sdks/python/src/polaris_key/s.py", rule: "ruff:E401" },
      { file: "sdks/python/src/polaris_key/s.py", rule: "ruff:F401" },
      { file: "sdks/python/src/polaris_key/s.py", rule: "ruff:F401" },
    ]);
  });
  it("names a syntax error (code null) and takes an empty array", () => {
    const one = JSON.stringify([{ filename: "/repo/a.py", code: null }]);
    expect(ruff(one, { root: "/repo" })).toEqual([
      { file: "a.py", rule: "ruff:syntax-error" },
    ]);
    expect(ruff("[]", { root: "/repo" })).toEqual([]);
  });
  it("throws on foreign input and on a path outside the root", () => {
    expect(() => ruff("src/x.py:1: error", { root: "/repo" })).toThrow();
    expect(() => ruff('{"a":1}', { root: "/repo" })).toThrow();
    expect(() =>
      ruff(JSON.stringify([{ filename: "/other/a.py", code: "F401" }]), {
        root: "/repo",
      }),
    ).toThrow(/outside/);
  });
});

describe("mypy adapter", () => {
  it("takes errors only, relative to sdks/python, with the error code", () => {
    expect(mypy(fixture("mypy.jsonl"), { root: "/repo" })).toEqual([
      { file: "sdks/python/src/polaris_key/s.py", rule: "mypy:return-value" },
      { file: "sdks/python/src/polaris_key/t.py", rule: "mypy:error" },
    ]);
  });
  it("accepts an absolute path and empty output", () => {
    const line = JSON.stringify({
      file: "/repo/sdks/python/a.py",
      severity: "error",
      code: "misc",
    });
    expect(mypy(line, { root: "/repo" })).toEqual([
      { file: "sdks/python/a.py", rule: "mypy:misc" },
    ]);
    expect(mypy("", { root: "/repo" })).toEqual([]);
  });
  it("throws on foreign input", () => {
    expect(() => mypy("a.py:1: error: x  [misc]", { root: "/repo" })).toThrow();
    expect(() => mypy('{"x":1}', { root: "/repo" })).toThrow();
  });
});
