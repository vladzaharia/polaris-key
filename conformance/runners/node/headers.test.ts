// @pkey-feature core.headers
// The Node conformance runner for `conformance/corpus/v2/headers.json` (WIRE-CONTRACT-V3 §5.2).
// It covers React too, since both JS SDKs map through the same `client-core` functions. The
// Python (`tests/test_headers.py`), Swift (`HeadersTests.swift`) and Godot
// (`tests/suite_conformance.gd`) runners and the Worker (`test/headersCorpus.test.ts`) run the
// same rows.
//
// Every row goes through `canonicalPlatform` / `canonicalArch`; the tables in
// `@polaris-key/protocol/core` must equal the map derived from the non-null rows, and their
// values must be in the generated `PLATFORM_VALUES` / `ARCH_VALUES`.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalArch, canonicalPlatform } from "@polaris-key/client-core";
import { ARCH_SPELLINGS, PLATFORM_SPELLINGS } from "@polaris-key/protocol/core";
import { ARCH_VALUES, PLATFORM_VALUES } from "@polaris-key/node";

interface HeaderCase {
  id: string;
  description: string;
  raw: string;
  expect: string | null;
}

interface HeadersCorpus {
  headersVersion: number;
  platformCases: HeaderCase[];
  archCases: HeaderCase[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(join(HERE, "..", "..", "corpus", "v2", "headers.json"), "utf8"),
) as HeadersCorpus;

/** ASCII-only folding, restated so the runner does not lean on the code it checks. */
const fold = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** The table the rows describe: each non-null row's folded raw to its expect. */
function derivedTable(rows: HeaderCase[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows)
    if (row.expect !== null) out[fold(row.raw)] = row.expect;
  return out;
}

const SECTIONS = [
  {
    name: "platformCases",
    rows: corpus.platformCases,
    map: canonicalPlatform as (raw: string) => string | null,
    table: PLATFORM_SPELLINGS as Record<string, string>,
    values: PLATFORM_VALUES as readonly string[],
  },
  {
    name: "archCases",
    rows: corpus.archCases,
    map: canonicalArch as (raw: string) => string | null,
    table: ARCH_SPELLINGS as Record<string, string>,
    values: ARCH_VALUES as readonly string[],
  },
] as const;

/** One row's verdict: the mapping's answer equals `expect`. */
const rowPasses = (
  map: (raw: string) => string | null,
  row: HeaderCase,
): boolean => map(row.raw) === row.expect;

describe("headers.json (WIRE-CONTRACT-V3 §5.2)", () => {
  it("is headersVersion 2", () => {
    expect(corpus.headersVersion).toBe(2);
  });

  for (const section of SECTIONS) {
    describe(section.name, () => {
      it("holds at least the rows the plan counts (an emptied section fails)", () => {
        expect(section.rows.length).toBeGreaterThanOrEqual(31);
      });

      it.each(section.rows.map((r) => [r.id, r] as const))("%s", (_id, row) => {
        expect(section.map(row.raw)).toBe(row.expect);
      });

      it("the table equals the map derived from the rows", () => {
        expect({ ...section.table }).toEqual(derivedTable(section.rows));
        for (const value of Object.values(section.table))
          expect(section.values).toContain(value);
      });

      it("a doctored row fails the same comparison", () => {
        const row = section.rows.find((r) => r.expect !== null)!;
        const doctored = {
          ...row,
          expect: row.expect === "linux" ? "macos" : "linux",
        };
        expect(rowPasses(section.map, row)).toBe(true);
        expect(rowPasses(section.map, doctored)).toBe(false);
      });
    });
  }

  it("never reads through the prototype", () => {
    for (const raw of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(canonicalPlatform(raw)).toBeNull();
      expect(canonicalArch(raw)).toBeNull();
    }
  });
});
