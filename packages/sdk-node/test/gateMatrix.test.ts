// Cross-SDK gate-parity conformance. Drives the shared `conformance/corpus/v1/gate-matrix.json`
// fixture through the Node SDK's gate and asserts every row reaches the decision the fixture
// pins. The Python (pytest), Swift (XCTest), and React (vitest) suites run the SAME fixture
// through their own ports — so the four gate matrices can't silently diverge.
//
// Each row carries two halves: the build-gate inputs (version / channel / compat window /
// entitlements), which the server enforces and the SDK mirrors via `checkBuildGate` below,
// and the license-state inputs (token / doc window / now / sync outcome). We compute the
// 403-style `blocked` from the build gate, feed it into `licenseState`, and compare the
// resulting {status, ok, reason, allowedRange} to the fixture.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AllowedRange,
  BlockReason,
  ManagedConfigDoc,
  ManagedEntry,
} from "@polaris-key/protocol";
import { channelForVersion, compareSemver, isDevBuild } from "../src/semver.js";
import { isUsable, licenseState } from "../src/gate.js";

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
  readFileSync(join(here, "..", "..", "..", "conformance", "corpus", "v1", "gate-matrix.json"), "utf8"),
) as Matrix;

// ── Build-gate port (mirrors packages/worker/src/gate.ts `checkBuildGate`) ──────────
// Intentionally rebuilt here from the SDK's exported semver/channel primitives: that is
// exactly the surface every SDK must keep in lockstep, and the fixture is the oracle.
function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}
function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value) ? (e.value.filter((v) => typeof v === "string") as string[]) : undefined;
}
function tighterMin(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}
function tighterMax(a: string | undefined, b: string | undefined): string | undefined {
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

interface Blocked {
  reason: BlockReason;
  allowedRange?: AllowedRange;
}

function checkBuildGate(g: GateInputs): Blocked | undefined {
  if (isDevBuild(g.version)) return undefined;
  const min = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]));
  const max = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]));
  const allowedRange: AllowedRange = {};
  if (min) allowedRange.min = min;
  if (max) allowedRange.max = max;
  if (min && compareSemver(g.version, min) < 0) return { reason: "version-too-old", allowedRange };
  if (max && compareSemver(g.version, max) > 0) return { reason: "version-too-new", allowedRange };
  const channel = normalizeChannel(g.channel ?? channelForVersion(g.version));
  if (channel !== "stable" && channel !== "dev") {
    const allowed = arrEnt(g.entitlements["channels"]) ?? ["stable"];
    if (!allowed.includes(channel)) return { reason: "channel-not-entitled" };
  }
  return undefined;
}

function buildDoc(l: LicenseInputs): ManagedConfigDoc | null {
  if (l.issuedAt === undefined || l.expiresAt === undefined || l.graceUntil === undefined) return null;
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_matrix",
    deviceId: "dev_matrix",
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceUntil: l.graceUntil,
    profile: { name: "M", firstName: "M", email: "m@x.y", enrolledAt: 0 },
    payload: { config: {}, secrets: {}, entitlements: {} },
  };
}

describe(`gate-matrix v${matrix.gateMatrixVersion} (Node)`, () => {
  it("has rows", () => {
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  for (const row of matrix.rows) {
    it(row.name, () => {
      const blocked = checkBuildGate(row.gate);
      const state = licenseState({
        hasToken: row.license.hasToken,
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
        expect(state.allowedRange, `${row.name} allowedRange`).toEqual(row.expect.allowedRange);
      } else {
        expect(state.allowedRange, `${row.name} no allowedRange`).toBeUndefined();
      }
    });
  }
});
