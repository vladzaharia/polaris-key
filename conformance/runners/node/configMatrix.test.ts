// @pkey-feature config.resolve config.list
// The Node conformance runner for `conformance/corpus/v2/config-matrix.json`
// (WIRE-CONTRACT-V3 §2.2.1), over `client-core`'s `resolveValue`, `resolveSource` and
// `listUserEntries`, the functions `@polaris-key/node` resolves through. React runs the same
// rows against `expectNoEnv` in `packages/sdk-react/test/configMatrix.test.ts`; Python, Swift
// and Godot have their own runners.
//
// Node has an environment layer, so every row is checked against `expect`. A `resolveValue` of
// `undefined` (nothing matched) reads as the row's `fallback`; `null` does not.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  listUserEntries,
  resolveSource,
  resolveValue,
  type ResolveContext,
} from "@polaris-key/client-core";
import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";

type Remote = Record<string, ManagedEntry> | null;
interface Expect {
  value: JSONValue;
  source: string;
}
interface ResolveCase {
  id: string;
  remote: Remote;
  localOverrides: Record<string, JSONValue>;
  env: Record<string, string>;
  envPrefix: string;
  key: string;
  fallback: JSONValue;
  expect: Expect;
  expectNoEnv?: Expect;
}
interface EnvValueCase {
  id: string;
  raw: string;
  value?: JSONValue;
  anyNumber?: true;
}
interface ListEntry {
  key: string;
  value: JSONValue;
  enforced: boolean;
}
interface ListCase {
  id: string;
  remote: Remote;
  localOverrides: Record<string, JSONValue>;
  env: Record<string, string>;
  envPrefix: string;
  expect: ListEntry[];
  expectNoEnv?: ListEntry[];
}
interface ConfigMatrix {
  configMatrixVersion: number;
  resolveCases: ResolveCase[];
  envValueCases: EnvValueCase[];
  listCases: ListCase[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "corpus", "v2", "config-matrix.json"),
    "utf8",
  ),
) as ConfigMatrix;

/** Canonical JSON equality: keys unordered, arrays ordered, numbers by value (-0 equals 0). */
function canonicalEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return (
      a.length === bb.length && a.every((x, i) => canonicalEqual(x, bb[i]))
    );
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return (
    ak.length === Object.keys(bo).length &&
    ak.every(
      (k) =>
        Object.prototype.hasOwnProperty.call(bo, k) &&
        canonicalEqual(ao[k], bo[k]),
    )
  );
}

function ctxOf(c: {
  remote: Remote;
  localOverrides: Record<string, JSONValue>;
  env: Record<string, string>;
  envPrefix: string;
}): ResolveContext {
  return {
    remote: c.remote ?? undefined,
    localOverrides: c.localOverrides,
    env: c.env,
    envPrefix: c.envPrefix,
  };
}

function resolveOne(c: ResolveCase): Expect {
  const ctx = ctxOf(c);
  const v = resolveValue(ctx, c.key);
  return {
    value: v === undefined ? c.fallback : v,
    source: resolveSource(ctx, c.key),
  };
}

const resolvePasses = (c: ResolveCase): boolean => {
  const got = resolveOne(c);
  return (
    got.source === c.expect.source && canonicalEqual(got.value, c.expect.value)
  );
};

/** An `envValueCase` as the resolve case the file's description expands it to. */
function expand(c: EnvValueCase): ResolveCase {
  return {
    id: c.id,
    remote: null,
    localOverrides: {},
    env: { PKEY_CONFIG_value: c.raw },
    envPrefix: "PKEY_CONFIG_",
    key: "value",
    fallback: "(fallback)",
    expect: { value: c.value ?? null, source: "env" },
  };
}

const byKey = (a: ListEntry, b: ListEntry): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

describe("config-matrix.json (WIRE-CONTRACT-V3 §2.2.1)", () => {
  it("is configMatrixVersion 1, with at least the rows the plan counts", () => {
    expect(matrix.configMatrixVersion).toBe(1);
    expect(matrix.resolveCases.length).toBeGreaterThanOrEqual(24);
    expect(matrix.envValueCases.length).toBeGreaterThanOrEqual(82);
    expect(matrix.listCases.length).toBeGreaterThanOrEqual(8);
  });

  describe("resolveCases", () => {
    it.each(matrix.resolveCases.map((c) => [c.id, c] as const))(
      "%s",
      (_id, c) => {
        const got = resolveOne(c);
        expect(got.source).toBe(c.expect.source);
        expect(canonicalEqual(got.value, c.expect.value)).toBe(true);
      },
    );

    it("a doctored row fails the same comparison", () => {
      const row = matrix.resolveCases[0]!;
      expect(resolvePasses(row)).toBe(true);
      expect(
        resolvePasses({ ...row, expect: { ...row.expect, value: "doctored" } }),
      ).toBe(false);
    });
  });

  describe("envValueCases", () => {
    it.each(matrix.envValueCases.map((c) => [c.id, c] as const))(
      "%s",
      (_id, c) => {
        const row = expand(c);
        const got = resolveOne(row);
        expect(got.source).toBe("env");
        if (c.anyNumber) {
          expect(typeof got.value).toBe("number");
          expect(Number.isFinite(got.value)).toBe(true);
        } else {
          expect(canonicalEqual(got.value, c.value)).toBe(true);
        }
      },
    );

    it("a doctored row fails the same comparison", () => {
      const c = matrix.envValueCases.find((x) => x.id === "env-value-integer")!;
      expect(resolvePasses(expand(c))).toBe(true);
      expect(resolvePasses(expand({ ...c, value: 43 }))).toBe(false);
    });
  });

  describe("listCases", () => {
    const listOf = (c: ListCase): ListEntry[] =>
      listUserEntries(ctxOf(c)).sort(byKey);
    const listPasses = (c: ListCase): boolean => {
      const got = listOf(c);
      return (
        got.length === c.expect.length &&
        got.every(
          (e, i) =>
            e.key === c.expect[i]!.key &&
            e.enforced === c.expect[i]!.enforced &&
            canonicalEqual(e.value, c.expect[i]!.value),
        )
      );
    };

    it.each(matrix.listCases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
      expect(listPasses(c)).toBe(true);
    });

    it("a doctored row fails the same comparison", () => {
      const c = matrix.listCases[0]!;
      expect(listPasses(c)).toBe(true);
      expect(
        listPasses({
          ...c,
          expect: c.expect.map((e) => ({ ...e, enforced: !e.enforced })),
        }),
      ).toBe(false);
    });
  });
});
