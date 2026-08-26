// Cross-SDK gate-parity conformance. Drives the shared `conformance/corpus/v1/gate-matrix.json`
// fixture through the React SDK's gate (`core/gateModel` licenseState) and asserts every row
// reaches the decision the fixture pins — the same fixture the Node/Python/Swift suites run,
// so the four gate matrices can't silently diverge.
//
// The React SDK is the UI tier: it never computes the version/channel block itself (the
// Worker does, returning a 403 the transport surfaces as `blocked`). So for the build-gated
// rows we feed the fixture's own block decision (reason + allowedRange) into `licenseState`
// and assert it reflects it; for the rest we feed the doc window + token/sync inputs and
// assert the expiry/grace/activate/revoke transitions land identically to the other SDKs.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AllowedRange,
  BlockReason,
  ManagedConfigDoc,
} from "@plrs/protocol";
import { isUsable, licenseState } from "../src/core/gateModel.js";

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
  gate: {
    version: string;
    channel?: string;
    compatMin: string;
    compatMax: string;
  };
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

function buildDoc(l: LicenseInputs): ManagedConfigDoc | null {
  if (
    l.issuedAt === undefined ||
    l.expiresAt === undefined ||
    l.graceUntil === undefined
  )
    return null;
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_matrix",
    deviceId: "dev_matrix",
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceUntil: l.graceUntil,
    profile: { name: "M", firstName: "M", email: "m@x.y", activatedAt: 0 },
    payload: { config: {}, secrets: {}, entitlements: {} },
  };
}

describe(`gate-matrix v${matrix.gateMatrixVersion} (React)`, () => {
  it("has rows", () => {
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  for (const row of matrix.rows) {
    it(row.name, () => {
      // A build-gated row carries a 403-style block reason; the React transport surfaces it
      // as `blocked`. Non-build-gated rows have no reason → no block.
      const blocked =
        row.expect.reason !== undefined
          ? { reason: row.expect.reason, allowedRange: row.expect.allowedRange }
          : undefined;
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
});
