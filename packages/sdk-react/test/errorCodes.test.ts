// @pkey-feature core.errors
// Every error code this SDK raises is in the shared registry (conformance/parity/errors.json,
// generated into `src/constants.generated.ts` by `pnpm gen constants`).
//
// Two checks, because React's `PolarisError` takes a CLOSED union (`PolarisErrorCode` in
// `src/core/types.ts`): `pnpm typecheck` fails if that union holds a code the registry lacks,
// and the scan below fails if `src/**` raises a `PolarisError("<code>", …)` literal the registry
// lacks. A new code goes into errors.json first; then both pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as generated from "../src/constants.generated.js";
import {
  ERROR_CODE_KINDS,
  ERROR_CODE_VALUES,
  ErrorCode,
} from "../src/constants.generated.js";
import type { PolarisErrorCode } from "../src/core/types.js";
import * as barrel from "../src/index.js";
import {
  ErrorCode as BarrelErrorCode,
  PROTOCOL_VERSION,
} from "../src/index.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const RAISED = [
  /\bPolarisError\(\s*(?:[^"(),]*\?\?\s*)?"([a-z][a-z0-9_-]*)"/g,
  /\breadonly code = "([a-z][a-z0-9_-]*)"/g,
];

/** Every code literal one source text raises. */
function raisedCodes(text: string): string[] {
  return RAISED.flatMap((re) => [...text.matchAll(re)].map((m) => m[1]!));
}

/** The raised codes the registry lacks, each with where it was seen. */
function unregistered(
  files: { path: string; text: string }[],
  registry: readonly string[],
): string[] {
  const known = new Set(registry);
  return files.flatMap(({ path, text }) =>
    raisedCodes(text)
      .filter((code) => !known.has(code))
      .map((code) => `${path}: "${code}"`),
  );
}

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return sources(abs);
    if (!/\.tsx?$/.test(name) || name.endsWith(".generated.ts")) return [];
    return [{ path: relative(SRC, abs), text: readFileSync(abs, "utf8") }];
  });
}

// Compile-time: every code React's `PolarisError` can carry is a registered code.
const closedUnion: readonly ErrorCode[] = [] as PolarisErrorCode[];

describe("error-code registry (core.errors)", () => {
  it("every code src/ raises is registered", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(10);
    const raised = new Set(files.flatMap((f) => raisedCodes(f.text)));
    for (const code of ["sign-in-failed", "network", "service-disabled"])
      expect(raised).toContain(code);
    expect(unregistered(files, ERROR_CODE_VALUES)).toEqual([]);
    expect(closedUnion).toEqual([]);
  });

  it("fails on an unregistered literal (fixture)", () => {
    const fixture = {
      path: "fixture.ts",
      text: [
        'throw new PolarisError("sign-in-failed", "registered");',
        'onError(new PolarisError("brand-new-code", "not registered"));',
      ].join("\n"),
    };
    expect(unregistered([fixture], ERROR_CODE_VALUES)).toEqual([
      'fixture.ts: "brand-new-code"',
    ]);
  });

  it("the generated module is the registry, and the barrel exports it", () => {
    expect(ErrorCode.signInFailed).toBe("sign-in-failed");
    expect(ERROR_CODE_KINDS["bridge-missing"]).toBe("client");
    expect(Object.keys(ERROR_CODE_KINDS)).toEqual([...ERROR_CODE_VALUES]);
    expect(BarrelErrorCode).toBe(ErrorCode);
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it("the package root re-exports every generated constant", () => {
    // `export *` silently drops a name two star-exports both provide, so pin it: a constant the
    // generator gains (the channel vocabulary, a new enum) must be reachable from the root.
    const root = barrel as Record<string, unknown>;
    const missing = Object.keys(generated).filter(
      (name) => root[name] !== (generated as Record<string, unknown>)[name],
    );
    expect(missing).toEqual([]);
    expect(barrel.CHANNEL_STABLE).toBe("stable");
    expect(barrel.CHANNEL_ALIASES).toEqual({
      staging: "beta",
      latest: "stable",
    });
    expect(barrel.PR_NUMBER_MAX_DIGITS).toBe(7);
  });
});
