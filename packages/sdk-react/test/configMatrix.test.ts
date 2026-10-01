// @pkey-feature config.resolve config.list
// The React runner for `conformance/corpus/v2/config-matrix.json` (WIRE-CONTRACT-V3 §2.2.1).
// React has no environment layer (rule 3: a browser has none, and a desktop renderer must not
// inherit the host process's), so every row is checked against `expectNoEnv ?? expect`, through
// React's own entry points: `projectState` (which resolves the whole effective config, and used
// to throw on a key named like an `Object.prototype` member), `resolveConfigValue`,
// `configSource` and `listUserConfig`. React has no "no document yet" state, so `remote: null`
// is passed as `{}`, which gives the same answers.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import {
  configSource,
  listUserConfig,
  projectState,
  resolveConfigValue,
} from "../src/core/adapter.js";
import { servicesFromList } from "../src/core/services.js";
import type { PolarisState } from "../src/core/types.js";
import { makeDoc, NOW_SEC } from "./fixtures.js";

type Remote = Record<string, ManagedEntry> | null;
interface Expect {
  value: JSONValue;
  source: string;
}
interface ResolveCase {
  id: string;
  remote: Remote;
  localOverrides: Record<string, JSONValue>;
  key: string;
  fallback: JSONValue;
  expect: Expect;
  expectNoEnv?: Expect;
}
interface EnvValueCase {
  id: string;
  raw: string;
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
    join(
      HERE,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "config-matrix.json",
    ),
    "utf8",
  ),
) as ConfigMatrix;

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

function stateOf(
  remote: Remote,
  localOverrides: Record<string, JSONValue>,
): PolarisState {
  return projectState(
    "browser",
    { license: makeDoc(), config: remote ?? {} },
    { activation: "token", now: NOW_SEC },
    {
      localOverrides,
      capabilities: servicesFromList(["license", "config"]),
    },
  );
}

function resolveOne(c: ResolveCase): Expect {
  const state = stateOf(c.remote, c.localOverrides);
  const v = resolveConfigValue(
    state.configEntries,
    state.localOverrides,
    c.key,
  );
  return {
    value: v === undefined ? c.fallback : v,
    source: configSource(state, c.key),
  };
}

const passes = (got: Expect, want: Expect): boolean =>
  got.source === want.source && canonicalEqual(got.value, want.value);

const byKey = (a: ListEntry, b: ListEntry): number =>
  a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

function listPasses(c: ListCase, want: ListEntry[]): boolean {
  const got = listUserConfig(stateOf(c.remote, c.localOverrides)).sort(byKey);
  return (
    got.length === want.length &&
    got.every(
      (e, i) =>
        e.key === want[i]!.key &&
        e.enforced === want[i]!.enforced &&
        canonicalEqual(e.value, want[i]!.value),
    )
  );
}

describe("config-matrix.json without an environment (WIRE-CONTRACT-V3 §2.2.1 rule 3)", () => {
  it("is configMatrixVersion 1, with at least the rows the plan counts", () => {
    expect(matrix.configMatrixVersion).toBe(1);
    expect(matrix.resolveCases.length).toBeGreaterThanOrEqual(24);
    expect(matrix.envValueCases.length).toBeGreaterThanOrEqual(82);
    expect(matrix.listCases.length).toBeGreaterThanOrEqual(8);
  });

  it.each(matrix.resolveCases.map((c) => [c.id, c] as const))(
    "resolve %s",
    (_id, c) => {
      const got = resolveOne(c);
      const want = c.expectNoEnv ?? c.expect;
      expect(got.source).toBe(want.source);
      expect(canonicalEqual(got.value, want.value)).toBe(true);
    },
  );

  // An envValueCase expands to a resolve case whose no-environment answer is the fallback.
  it.each(matrix.envValueCases.map((c) => [c.id, c] as const))(
    "env value %s",
    (_id, c) => {
      const got = resolveOne({
        id: c.id,
        remote: null,
        localOverrides: {},
        key: "value",
        fallback: "(fallback)",
        expect: { value: "(fallback)", source: "fallback" },
      });
      expect(passes(got, { value: "(fallback)", source: "fallback" })).toBe(
        true,
      );
    },
  );

  it.each(matrix.listCases.map((c) => [c.id, c] as const))(
    "list %s",
    (_id, c) => {
      expect(listPasses(c, c.expectNoEnv ?? c.expect)).toBe(true);
    },
  );

  it("a doctored row fails the same comparison", () => {
    const row = matrix.resolveCases.find(
      (c) => c.id === "env-beats-remote-default",
    )!;
    // React has no environment: the `expect` answer (env) is the doctored one here.
    expect(passes(resolveOne(row), row.expectNoEnv!)).toBe(true);
    expect(passes(resolveOne(row), row.expect)).toBe(false);
    const list = matrix.listCases[0]!;
    expect(listPasses(list, list.expectNoEnv ?? list.expect)).toBe(true);
    expect(listPasses(list, list.expect.slice(1))).toBe(false);
  });
});
