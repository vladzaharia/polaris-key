// The Worker half of the gate-matrix conformance check (P0-04, D6).
//
// Every SDK runner ports the build gate to replay `gate-matrix.json`; this test makes the REAL
// server gate, `checkBuildGate`, the oracle for the same rows. A port that drifts from the
// server, or a doctored `expect.reason`, therefore fails here as well as in the runners. The
// SDK halves live in conformance/runners/node, sdks/python/tests and sdks/swift/Tests.
//
// @pkey-feature license.gate

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AllowedRange,
  BlockReason,
  ManagedEntry,
} from "@polaris-key/protocol";
import { checkBuildGate } from "../src/core/gate.js";

interface MatrixRow {
  name: string;
  gate: {
    version: string;
    channel?: string;
    compatMin: string;
    compatMax: string;
    entitlements: Record<string, ManagedEntry>;
  };
  expect: {
    status: string;
    ok: boolean;
    reason?: BlockReason;
    allowedRange?: AllowedRange;
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    join(
      here,
      "..",
      "..",
      "..",
      "conformance",
      "corpus",
      "v2",
      "gate-matrix.json",
    ),
    "utf8",
  ),
) as { gateMatrixVersion: number; rows: MatrixRow[] };

describe("gate-matrix v2 — the server build gate is the oracle", () => {
  it("is gate-matrix v2 with the P0-04 channel rows", () => {
    expect(matrix.gateMatrixVersion).toBe(2);
    expect(matrix.rows).toHaveLength(38);
    const names = matrix.rows.map((r) => r.name);
    expect(names).not.toContain(
      "ok — dev build bypasses the gate despite an out-of-range window + non-entitled channel",
    );
    expect(names).toContain(
      "version-too-old — dev build without the dev entitlement gets no bypass (R3-01)",
    );
  });

  it.each(matrix.rows.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    const result = checkBuildGate({
      version: row.gate.version,
      ...(row.gate.channel === undefined
        ? {}
        : { channelHeader: row.gate.channel }),
      entitlements: row.gate.entitlements,
      compatMin: row.gate.compatMin,
      compatMax: row.gate.compatMax,
    });
    // `reason` is the build-gate hint; undefined on rows whose gate passes.
    expect(result.reason).toEqual(row.expect.reason);
    // Where the gate's hint IS the decision, its range is the one surfaced.
    if (row.expect.status === row.expect.reason)
      expect(result.allowedRange).toEqual(row.expect.allowedRange);
  });
});
