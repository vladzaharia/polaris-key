/**
 * The integration goldens compile (SP-33a): every TypeScript, TSX and Python block `renderUsage`
 * renders is compiled in the docs snippet lanes, next to the real `pkey sdk` output, exactly as a
 * reader's file would be. The goldens are written by `pnpm gen integration`; a snippet that stops
 * compiling against the SDKs fails here, not on a reader's machine.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO, type Snippet } from "./snippets/extract";
import {
  compilePython,
  compileTs,
  pythonBin,
  type Failure,
} from "./snippets/lanes";

const DIR = join(REPO, "packages/shared-manifest/test/fixtures/integration");

interface IndexRow {
  id: string;
  file: string;
  sdk: string;
  lane: string;
  language: "ts" | "tsx" | "python" | "swift" | "kotlin" | "gdscript";
  compiled: boolean;
}

const index = JSON.parse(
  readFileSync(join(DIR, "index.json"), "utf8"),
) as IndexRow[];

function snippetOf(row: IndexRow): Snippet {
  return {
    file: `packages/shared-manifest/test/fixtures/integration/${row.file}`,
    line: 1,
    lang: row.language as Snippet["lang"],
    meta: "",
    optOut: false,
    code: readFileSync(join(DIR, row.file), "utf8"),
  };
}

const show = (fs: Failure[]): string =>
  fs.map((f) => `${f.snippet.file}:${f.line} ${f.message}`).join("\n");

const compiled = index.filter((r) => r.compiled);
const python = pythonBin();
const LONG = 240_000;
const pyIt = python ? it : process.env.CI ? it : it.skip;

describe("integration goldens", () => {
  it("covers TypeScript and Python in every lane", () => {
    const langs = new Set(compiled.map((r) => r.language));
    expect([...langs].sort()).toEqual(["python", "ts", "tsx"]);
  });

  it(
    "compile in the TypeScript lanes",
    () => {
      const blocks = compiled
        .filter((r) => r.language !== "python")
        .map(snippetOf);
      expect(blocks.length).toBeGreaterThan(10);
      expect(show(compileTs(blocks))).toBe("");
    },
    LONG,
  );

  pyIt(
    "compile in the Python lane",
    () => {
      const blocks = compiled
        .filter((r) => r.language === "python")
        .map(snippetOf);
      expect(blocks.length).toBeGreaterThan(5);
      expect(show(compilePython(blocks, python ?? "python3"))).toBe("");
    },
    LONG,
  );
});
