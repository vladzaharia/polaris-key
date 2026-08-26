// v3 gate ⊇ v2 gate.
//
// Drives the frozen `conformance/corpus/v1/gate-matrix.json` — the fixture the Node, React,
// Python and Swift v2 gates all agree on — through the NEW `licenseState`, mapping each v1 row
// with the smallest possible shim: `licenseServiceEnabled: true` (every v1 product licensed)
// and `hasToken → activation`. Every row must reach the same {status, ok, allowedRange}. If
// this file goes red, the v3 gate changed a v2 decision, which is a wire break.
//
// Corpus v2 (Task 0.6) adds the rows v1 cannot express — `not-applicable` and
// `activation: "bundle"` — and supersedes this runner in P4; until then this is the proof.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@plrs/protocol/core";
import type {
  AllowedRange,
  BlockReason,
  LicenseDoc,
} from "@plrs/protocol/license";
import { channelForVersion, compareSemver, isDevBuild } from "../src/semver.js";
import { isUsable, licenseState, type BlockedState } from "../src/gate.js";

interface GateInputs {
  version: string;
  channel?: string;
  compatMin: string;
  compatMax: string;
  entitlements: Record<string, ManagedEntry>;
}
interface LicenseInputs {
  hasToken: boolean;
  now: number;
  issuedAt?: number;
  expiresAt?: number;
  graceUntil?: number;
  lastSyncUnauthorized?: boolean;
  lastVerifiedAt?: number;
}
interface ExpectDecision {
  status: string;
  ok: boolean;
  reason?: BlockReason;
  allowedRange?: AllowedRange;
}
interface MatrixRow {
  name: string;
  gate: GateInputs;
  license: LicenseInputs;
  expect: ExpectDecision;
}
interface Matrix {
  gateMatrixVersion: number;
  rows: MatrixRow[];
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
      "v1",
      "gate-matrix.json",
    ),
    "utf8",
  ),
) as Matrix;

// ── Build-gate port (mirrors packages/worker/src/gate.ts `checkBuildGate`) ──────────
// Intentionally rebuilt here from client-core's exported semver/channel primitives: that is
// exactly the surface every SDK must keep in lockstep, and the fixture is the oracle.
function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}
function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value)
    ? (e.value.filter((v) => typeof v === "string") as string[])
    : undefined;
}
function tighterMin(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}
function tighterMax(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) <= 0 ? a : b;
}
function normalizeChannel(header: string): "stable" | "staging" | "pr" | "dev" {
  if (header === "staging") return "staging";
  if (header === "pr" || /^pr-?\d*/.test(header)) return "pr";
  if (header === "dev") return "dev";
  return "stable";
}

function checkBuildGate(g: GateInputs): BlockedState | undefined {
  if (isDevBuild(g.version)) return undefined;
  const min = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]));
  const max = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]));
  const allowedRange: AllowedRange = {};
  if (min) allowedRange.min = min;
  if (max) allowedRange.max = max;
  if (min && compareSemver(g.version, min) < 0)
    return { reason: "version-too-old", allowedRange };
  if (max && compareSemver(g.version, max) > 0)
    return { reason: "version-too-new", allowedRange };
  const channel = normalizeChannel(g.channel ?? channelForVersion(g.version));
  if (channel !== "stable" && channel !== "dev") {
    const allowed = arrEnt(g.entitlements["channels"]) ?? ["stable"];
    if (!allowed.includes(channel)) return { reason: "channel-not-entitled" };
  }
  return undefined;
}

/** The v1 doc window, rebuilt as a v3 `plrs-license+jws` payload. The gate only reads the
 *  three timestamps, so the rest is fixture furniture. */
function buildDoc(l: LicenseInputs): LicenseDoc | null {
  if (
    l.issuedAt === undefined ||
    l.expiresAt === undefined ||
    l.graceUntil === undefined
  )
    return null;
  return {
    aud: "djdl",
    iss: "plrs.im",
    licenseId: "lic_matrix",
    deviceId: "dev_matrix",
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceUntil: l.graceUntil,
    profile: { name: "M", firstName: "M", email: "m@x.y", activatedAt: 0 },
    entitlements: {},
  };
}

describe(`gate-matrix v${matrix.gateMatrixVersion} → v3 gate parity`, () => {
  it("has rows", () => {
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  for (const row of matrix.rows) {
    it(row.name, () => {
      const blocked = checkBuildGate(row.gate);
      const state = licenseState({
        // The whole shim: every v1 product licensed, and hasToken → activation.
        licenseServiceEnabled: true,
        activation: row.license.hasToken ? "token" : null,
        doc: buildDoc(row.license),
        now: row.license.now,
        lastSyncUnauthorized: row.license.lastSyncUnauthorized,
        lastVerifiedAt: row.license.lastVerifiedAt,
        blocked,
      });
      expect(state.status, row.name).toBe(row.expect.status);
      expect(isUsable(state.status), `${row.name} usable`).toBe(row.expect.ok);
      if (row.expect.reason !== undefined) {
        expect(blocked?.reason, `${row.name} reason`).toBe(row.expect.reason);
      }
      if (row.expect.allowedRange !== undefined) {
        expect(state.allowedRange, `${row.name} allowedRange`).toEqual(
          row.expect.allowedRange,
        );
      } else {
        expect(
          state.allowedRange,
          `${row.name} no allowedRange`,
        ).toBeUndefined();
      }
    });
  }

  it("no v1 row exercises the one ordering v3 changed (unactivated + blocked)", () => {
    // v3 §5 puts the activation guard ahead of the `blocked` hint (see gate.test.ts). That is
    // only observable on a row with hasToken:false AND a build block — which the v1 matrix
    // never pins. Asserted, not assumed: if corpus v1 ever gains such a row, this fails loudly
    // instead of the parity suite silently changing meaning.
    const ambiguous = matrix.rows.filter(
      (r) => !r.license.hasToken && checkBuildGate(r.gate) !== undefined,
    );
    expect(ambiguous.map((r) => r.name)).toEqual([]);
  });
});
