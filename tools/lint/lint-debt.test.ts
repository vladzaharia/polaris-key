/**
 * P0-46.1: the lint-debt ledger mechanism (tools/lint/lint-debt.mjs), driven through the jsonl-test
 * fixture adapter. Pure functions through `run`, plus the real CLI over stdin.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { excluded, loadGenerated, run, tally } from "./lint-debt.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "lint-debt.mjs");

const lines = (...f: [string, string][]) =>
  f.map(([file, rule]) => JSON.stringify({ file, rule })).join("\n");
const ledgerOf = (debt: Record<string, Record<string, number>>) =>
  JSON.stringify({ version: 1, debt }, null, 2);

let dir: string;
let ledger: string;
let input: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lint-debt-"));
  ledger = join(dir, "ledger.json");
  input = join(dir, "in.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const check = (text: string, mode = "check") => {
  writeFileSync(input, text);
  return run([
    mode,
    "--tool",
    "jsonl-test",
    "--ledger",
    ledger,
    "--input",
    input,
  ]);
};

describe("check", () => {
  it("passes on an equal count", async () => {
    writeFileSync(ledger, ledgerOf({ "a.py": { "jsonl-test:X": 2 } }));
    const r = await check(lines(["a.py", "X"], ["a.py", "X"]));
    expect(r.code).toBe(0);
  });

  it("fails on a new finding, a higher count and a new rule", async () => {
    writeFileSync(ledger, ledgerOf({ "a.py": { "jsonl-test:X": 1 } }));
    const r = await check(
      lines(["b.py", "Y"], ["a.py", "X"], ["a.py", "X"], ["a.py", "Z"]),
    );
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "new: a.py jsonl-test:X 2 (ledger 1)",
      "new: a.py jsonl-test:Z 1 (ledger 0)",
      "new: b.py jsonl-test:Y 1 (ledger 0)",
    ]);
  });

  it("fails on a stale entry and a lowered count: the ledger only shrinks", async () => {
    writeFileSync(
      ledger,
      ledgerOf({
        "a.py": { "jsonl-test:X": 3 },
        "c.py": { "jsonl-test:Q": 1 },
      }),
    );
    const r = await check(lines(["a.py", "X"]));
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "cleared (re-record): a.py jsonl-test:X 1 (ledger 3)",
      "cleared (re-record): c.py jsonl-test:Q 0 (ledger 1)",
    ]);
  });

  it("ignores another tool's rules in a shared ledger", async () => {
    writeFileSync(ledger, ledgerOf({ "a.py": { "other:R": 5 } }));
    expect((await check("")).code).toBe(0);
  });

  it("excludes a generated output and build/venv trees", async () => {
    writeFileSync(ledger, ledgerOf({}));
    const r = await check(
      lines(
        ["conformance/corpus/v2/cases.json", "X"],
        ["sdks/python/.venv/lib/x.py", "X"],
        ["sdks/kotlin/core/build/Gen.kt", "X"],
        ["packages/a/node_modules/x.js", "X"],
        ["packages/a/dist/x.js", "X"],
      ),
    );
    expect(r.code).toBe(0);
  });

  it("exits 2 on a parse error, an unknown adapter, a bad finding and a missing prefix", async () => {
    writeFileSync(ledger, ledgerOf({}));
    expect((await check("not json")).code).toBe(2);
    expect((await check(lines(["/abs.py", "X"]))).code).toBe(2);
    expect((await check(lines(["../up.py", "X"]))).code).toBe(2);
    expect(
      (
        await run([
          "check",
          "--tool",
          "nope",
          "--ledger",
          ledger,
          "--input",
          input,
        ])
      ).code,
    ).toBe(2);
    expect((await run(["check", "--ledger", ledger])).code).toBe(2);
    expect((await run(["bogus"])).code).toBe(2);
  });
});

describe("record", () => {
  it("round-trips: record, then check passes, byte-identical on a second record", async () => {
    const text = lines(
      ["z.py", "B"],
      ["a.py", "B"],
      ["a.py", "A"],
      ["a.py", "A"],
    );
    expect((await check(text, "record")).code).toBe(0);
    const first = readFileSync(ledger, "utf8");
    expect(JSON.parse(first)).toMatchObject({
      version: 1,
      debt: {
        "a.py": { "jsonl-test:A": 2, "jsonl-test:B": 1 },
        "z.py": { "jsonl-test:B": 1 },
      },
    });
    expect((await check(text)).code).toBe(0);
    await check(
      lines(["a.py", "A"], ["a.py", "A"], ["a.py", "B"], ["z.py", "B"]),
      "record",
    );
    expect(readFileSync(ledger, "utf8")).toBe(first);
  });

  it("sorts files and rules, and keeps another tool's rules and the $comment", async () => {
    writeFileSync(
      ledger,
      JSON.stringify({
        $comment: "mine",
        version: 1,
        debt: { "m.py": { "other:R": 4 }, "a.py": { "jsonl-test:OLD": 9 } },
      }),
    );
    await check(lines(["z.py", "B"], ["b.py", "A"]), "record");
    const l = JSON.parse(readFileSync(ledger, "utf8"));
    expect(l.$comment).toBe("mine");
    expect(Object.keys(l.debt)).toEqual(["b.py", "m.py", "z.py"]);
    expect(l.debt["m.py"]).toEqual({ "other:R": 4 });
  });

  it("shrinks the ledger after a fix", async () => {
    writeFileSync(ledger, ledgerOf({ "a.py": { "jsonl-test:X": 3 } }));
    expect((await check(lines(["a.py", "X"]))).code).toBe(1);
    await check(lines(["a.py", "X"]), "record");
    expect((await check(lines(["a.py", "X"]))).code).toBe(0);
  });
});

describe("determinism and the snapshot", () => {
  it("orders output by file then rule whatever the input order", async () => {
    writeFileSync(ledger, ledgerOf({}));
    const a = await check(lines(["b", "Y"], ["a", "Z"], ["a", "A"]));
    const b = await check(lines(["a", "A"], ["a", "Z"], ["b", "Y"]));
    expect(a.out).toEqual(b.out);
    expect(a.out[0]).toBe("new: a jsonl-test:A 1 (ledger 0)");
  });

  it("tally sorts by code point", () => {
    expect(
      Object.keys(
        tally([
          { file: "b", rule: "x" },
          { file: "B", rule: "x" },
          { file: "a", rule: "x" },
        ]),
      ),
    ).toEqual(["B", "a", "b"]);
  });

  it("excluded() reads the registry snapshot", () => {
    const g = loadGenerated();
    expect(g.length).toBeGreaterThan(10);
    expect(excluded("conformance/corpus/v2/cases.json", g)).toBe(true);
    expect(excluded("packages/worker/src/router.ts", g)).toBe(false);
  });
});

describe("CLI over stdin", () => {
  const cli = (args: string[], stdin: string) =>
    spawnSync("node", [SCRIPT, ...args], { input: stdin, encoding: "utf8" });

  it("records then checks from stdin with real exit codes", () => {
    const base = ["--tool", "jsonl-test", "--ledger", ledger];
    const text = lines(["a.py", "X"]);
    expect(cli(["record", ...base], text).status).toBe(0);
    expect(cli(["check", ...base], text).status).toBe(0);
    const bad = cli(["check", ...base], lines(["a.py", "X"], ["a.py", "X"]));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("new: a.py jsonl-test:X 2 (ledger 1)");
    expect(cli(["check", ...base], "garbage").status).toBe(2);
  });
});

describe("size budget (P0-30.3)", () => {
  const sizeRun = (mode: string, text: string) => {
    writeFileSync(input, text);
    return run([mode, "--tool", "size", "--ledger", ledger, "--input", input]);
  };
  const over = (file: string, n: number) => `${file}\t${n}\n`;

  it("fails a new 801-line file as new:", async () => {
    writeFileSync(ledger, ledgerOf({}));
    const r = await sizeRun("check", over("packages/worker/src/a.ts", 801));
    expect(r.code).toBe(1);
    expect(r.out).toEqual([
      "new: packages/worker/src/a.ts size:over-800 1 (ledger 0)",
    ]);
  });

  it("fails a ledgered file cut to 800 as cleared (re-record):", async () => {
    writeFileSync(
      ledger,
      ledgerOf({ "packages/worker/src/a.ts": { "size:over-800": 1 } }),
    );
    const r = await sizeRun("check", "");
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("cleared (re-record): packages/worker/src/a.ts");
  });

  it("skips a generated file and passes a ledgered one", async () => {
    writeFileSync(
      ledger,
      ledgerOf({ "packages/worker/src/a.ts": { "size:over-800": 1 } }),
    );
    const text = readFileSync(join(HERE, "fixtures", "size.txt"), "utf8");
    expect((await sizeRun("check", text)).code).toBe(0);
  });
});
