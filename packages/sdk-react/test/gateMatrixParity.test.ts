// Cross-SDK gate-parity conformance, re-baselined onto `conformance/corpus/v2/gate-matrix.json`
// (wire contract v3 §5). Every row runs through the SAME `@polaris-key/client-core` `licenseState` the
// Node runner drives — this package no longer carries a port of it to diverge from — and then
// through `projectState`, so the assertion covers the React PROJECTION as well as the gate.
//
// That second half is the point of keeping this suite. The gate itself is proven by
// `conformance/runners/node/corpusV2.test.ts`; what only this file can prove is that the React
// state machine feeds it the right inputs — `licenseServiceEnabled` from the capability map,
// `activation` from the transport, `highWaterMark` from the clock floor.
//
// The React SDK is the UI tier: it never computes the version/channel block itself (the Worker
// does, returning a 403 the transport surfaces as `blocked`). So for the build-gated rows we
// feed the fixture's own block decision (reason + allowedRange) rather than re-deriving it.
//
// v1→v2 row deltas this re-baseline picks up: `licenseServiceEnabled: false ⇒ not-applicable`
// (D-08), `activation: "bundle"` for air-gapped installs (§7), and v3's ordering change —
// the activation guard now runs BEFORE the unsigned `blocked` hint.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isUsable, licenseState } from "@polaris-key/client-core";
import type {
  ActivationSource,
  AllowedRange,
  BlockReason,
  LicenseDoc,
} from "@polaris-key/protocol/license";
import { projectState } from "../src/core/adapter.js";
import { noServices, servicesFromList } from "../src/core/services.js";

interface LicenseInputs {
  licenseServiceEnabled: boolean;
  activation: ActivationSource | null;
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
      "v2",
      "gate-matrix.json",
    ),
    "utf8",
  ),
) as Matrix;

/** The gate reads only the three timestamps; the rest is fixture furniture. */
function buildDoc(l: LicenseInputs): LicenseDoc | null {
  if (
    l.issuedAt === undefined ||
    l.expiresAt === undefined ||
    l.graceUntil === undefined
  )
    return null;
  return {
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "lic_matrix",
    deviceId: "dev_matrix",
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
    graceUntil: l.graceUntil,
    entitlements: {},
  };
}

describe(`gate-matrix v${matrix.gateMatrixVersion} (React)`, () => {
  it("has rows", () => {
    expect(matrix.gateMatrixVersion).toBe(2);
    expect(matrix.rows.length).toBeGreaterThan(0);
  });

  for (const row of matrix.rows) {
    it(row.name, () => {
      // A build-gated row carries a 403-style block reason; the React transport surfaces it
      // as `blocked`. Non-build-gated rows have no reason → no block.
      const blocked =
        row.expect.reason !== undefined
          ? { reason: row.expect.reason, allowedRange: row.expect.allowedRange }
          : null;
      const input = {
        licenseServiceEnabled: row.license.licenseServiceEnabled,
        activation: row.license.activation,
        doc: buildDoc(row.license),
        now: row.license.now,
        lastSyncUnauthorized: row.license.lastSyncUnauthorized,
        lastVerifiedAt: row.license.lastVerifiedAt,
        blocked,
      };
      const state = licenseState(input);
      expect(state.status, row.name).toBe(row.expect.status);
      expect(isUsable(state), `${row.name} usable`).toBe(row.expect.ok);
      expect(state.allowedRange, `${row.name} allowedRange`).toEqual(
        row.expect.allowedRange,
      );

      // The same row through the React projection: the capability map supplies
      // `licenseServiceEnabled`, so a state built for a config-only product reaches
      // `not-applicable` by the route the adapters actually take.
      const projected = projectState(
        "desktop",
        { license: input.doc, config: {} },
        {
          activation: input.activation,
          now: input.now,
          lastSyncUnauthorized: input.lastSyncUnauthorized,
          lastVerifiedAt: input.lastVerifiedAt,
          blocked,
        },
        {
          capabilities: row.license.licenseServiceEnabled
            ? servicesFromList(["license", "config"])
            : servicesFromList(["config"]),
        },
      );
      expect(projected.status, `${row.name} projected`).toBe(row.expect.status);
      expect(projected.gate).toEqual(state);
      expect(projected.activation).toBe(row.license.activation);
    });
  }
});

// ── The clock floor this package used to be missing ────────────────────────────────────────
//
// The pre-suite React port of the gate had no `highWaterMark` parameter at all, so a renderer
// was the one surface in the suite where winding the system clock back into a document's own
// window restored a lapsed session. These rows are the regression fence.

describe("monotonic clock floor (§4.2) reaches the React projection", () => {
  const doc: LicenseDoc = {
    aud: "acme",
    iss: "key.plrs.im",
    licenseId: "lic-1",
    deviceId: "dev-1",
    issuedAt: 1000,
    expiresAt: 4600,
    graceUntil: 10_000,
    entitlements: {},
  };
  const licensed = servicesFromList(["license", "config"]);

  it("an honest clock past graceUntil expires", () => {
    const s = projectState(
      "desktop",
      { license: doc, config: {} },
      { activation: "token", now: 20_000, highWaterMark: 0 },
      { capabilities: licensed },
    );
    expect(s.status).toBe("expired");
  });

  it("a clock wound back inside the window is overridden by the floor", () => {
    // System clock says 5 000 (inside grace), but the client has already verified an artifact
    // issued at 20 000. `max(now, floor)` = 20 000 ⇒ still expired.
    const s = projectState(
      "desktop",
      { license: doc, config: {} },
      { activation: "token", now: 5_000, highWaterMark: 20_000 },
      { capabilities: licensed },
    );
    expect(s.status).toBe("expired");
    expect(s.highWaterMark).toBe(20_000);
  });

  it("the floor costs nothing when the clock is truthful", () => {
    const s = projectState(
      "desktop",
      { license: doc, config: {} },
      { activation: "token", now: 1_500, highWaterMark: 1_000 },
      { capabilities: licensed },
    );
    expect(s.status).toBe("ok");
  });

  it("a product with no license service is not-applicable and usable", () => {
    const s = projectState(
      "browser",
      { license: null, config: {} },
      { activation: null, now: 1_500 },
      { capabilities: servicesFromList(["config"]) },
    );
    expect(s.status).toBe("not-applicable");
    expect(isUsable(s.status)).toBe(true);
  });

  it("a product with nothing enabled still reports not-applicable, never all-true", () => {
    const s = projectState(
      "browser",
      { license: null, config: {} },
      { activation: null, now: 1_500 },
      { capabilities: noServices() },
    );
    expect(s.status).toBe("not-applicable");
  });
});
