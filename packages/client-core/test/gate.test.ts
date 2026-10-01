// @pkey-feature license.gate
// The v3 gate. Ports the Node SDK's gate coverage onto the new `GateInput` and adds the
// three things v3 introduces: `not-applicable` for products without the license service,
// `activation: "bundle"` as a first-class activation, and the monotonic clock floor.

import { describe, expect, it } from "vitest";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import { isUsable, licenseState, type GateInput } from "../src/gate.js";

const ISSUED = 1000;
const EXPIRES = ISSUED + 3600; // 4600
const GRACE = ISSUED + 30 * 86400; // 2_593_000

function doc(over: Partial<LicenseDoc> = {}): LicenseDoc {
  return {
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "l",
    deviceId: "d",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    graceUntil: GRACE,
    profile: { name: "", firstName: "", email: "", activatedAt: 0 },
    entitlements: {},
    ...over,
  };
}

/** A licensed product with an online-activated device, unless a case says otherwise. */
function gate(over: Partial<GateInput> = {}): GateInput {
  return {
    licenseServiceEnabled: true,
    activation: "token",
    doc: null,
    now: ISSUED,
    ...over,
  };
}

describe("licenseState — not-applicable (v3 §5)", () => {
  it("a product without the license service is not-applicable and USABLE, doc or no doc", () => {
    const s = licenseState(
      gate({ licenseServiceEnabled: false, activation: null, doc: null }),
    );
    expect(s.status).toBe("not-applicable");
    expect(isUsable(s)).toBe(true);
    // …and no grace/lastVerified furniture leaks out of a state that has no license.
    expect(s.graceUntil).toBeUndefined();
    expect(s.allowedRange).toBeUndefined();
  });

  it("not-applicable short-circuits every other rule (403 block, hard 401, dead doc)", () => {
    for (const over of [
      { blocked: { reason: "version-too-old" as const } },
      { lastSyncUnauthorized: true },
      { doc: doc(), now: GRACE + 1 },
    ]) {
      expect(
        licenseState(
          gate({ licenseServiceEnabled: false, activation: null, ...over }),
        ).status,
      ).toBe("not-applicable");
    }
  });

  it("the SAME inputs with the service enabled are not usable (proving the flag flips it)", () => {
    const s = licenseState(
      gate({ licenseServiceEnabled: true, activation: null, doc: null }),
    );
    expect(s.status).toBe("needs-activation");
    expect(isUsable(s)).toBe(false);
  });
});

describe("licenseState — activation", () => {
  it("needs-activation with no activation at all", () => {
    expect(licenseState(gate({ activation: null })).status).toBe(
      "needs-activation",
    );
  });

  it("needs-activation with a token but no cached doc", () => {
    expect(licenseState(gate({ activation: "token", doc: null })).status).toBe(
      "needs-activation",
    );
  });

  it("a leftover doc without an activation is still needs-activation", () => {
    expect(
      licenseState(gate({ activation: null, doc: doc(), now: 1500 })).status,
    ).toBe("needs-activation");
  });

  it("an imported bundle activates: activation 'bundle' + a valid doc ⇒ ok", () => {
    const s = licenseState(
      gate({ activation: "bundle", doc: doc(), now: 1500 }),
    );
    expect(s.status).toBe("ok");
    expect(isUsable(s)).toBe(true);
    expect(s.graceUntil).toBe(GRACE);
  });

  it("a bundle-activated install ages out exactly like a token-activated one", () => {
    const past = { doc: doc(), now: GRACE + 1 };
    expect(licenseState(gate({ activation: "bundle", ...past })).status).toBe(
      "expired",
    );
    expect(licenseState(gate({ activation: "token", ...past })).status).toBe(
      "expired",
    );
  });
});

describe("licenseState — revoked", () => {
  it("revoked on a hard 401 even with a far-future valid doc", () => {
    const s = licenseState(
      gate({
        doc: doc({ graceUntil: 9_999_999 }),
        now: 1500,
        lastSyncUnauthorized: true,
      }),
    );
    expect(s.status).toBe("revoked");
  });

  it("without the 401 marker the same inputs are ok (proving the marker flips it)", () => {
    expect(
      licenseState(gate({ doc: doc({ graceUntil: 9_999_999 }), now: 1500 }))
        .status,
    ).toBe("ok");
  });
});

describe("licenseState — ok / grace / expired boundaries", () => {
  it("ok while now <= expiresAt", () => {
    const s = licenseState(
      gate({ doc: doc(), now: EXPIRES, lastVerifiedAt: 42 }),
    );
    expect(s.status).toBe("ok");
    expect(s.graceUntil).toBe(GRACE);
    expect(s.lastVerifiedAt).toBe(42);
  });

  it("grace boundary: exactly at expiresAt is still ok, one second past is grace", () => {
    expect(licenseState(gate({ doc: doc(), now: EXPIRES })).status).toBe("ok");
    const s = licenseState(
      gate({ doc: doc(), now: EXPIRES + 1, lastVerifiedAt: 7 }),
    );
    expect(s.status).toBe("grace");
    expect(s.graceUntil).toBe(GRACE);
    expect(s.lastVerifiedAt).toBe(7);
  });

  it("grace persists right up to graceUntil", () => {
    expect(licenseState(gate({ doc: doc(), now: GRACE })).status).toBe("grace");
  });

  it("expired boundary: exactly at graceUntil is grace, one second past is expired", () => {
    expect(licenseState(gate({ doc: doc(), now: GRACE })).status).toBe("grace");
    const s = licenseState(gate({ doc: doc(), now: GRACE + 1 }));
    expect(s.status).toBe("expired");
    expect(s.graceUntil).toBe(GRACE);
  });

  it("a null lastVerifiedAt is reported as absent, not as null", () => {
    const s = licenseState(
      gate({ doc: doc(), now: 1500, lastVerifiedAt: null }),
    );
    expect(s.lastVerifiedAt).toBeUndefined();
  });
});

describe("licenseState — blocked (403)", () => {
  it("reflects version-too-old + allowedRange", () => {
    const s = licenseState(
      gate({
        doc: doc(),
        now: 1500,
        blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
      }),
    );
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange).toEqual({ min: "2.0.0" });
  });

  it("reflects version-too-new with a max bound", () => {
    const s = licenseState(
      gate({
        doc: doc(),
        now: 1500,
        blocked: { reason: "version-too-new", allowedRange: { max: "1.0.0" } },
      }),
    );
    expect(s.status).toBe("version-too-new");
    expect(s.allowedRange?.max).toBe("1.0.0");
  });

  it("reflects channel-not-entitled (no range)", () => {
    const s = licenseState(
      gate({
        doc: doc(),
        now: 1500,
        blocked: { reason: "channel-not-entitled" },
      }),
    );
    expect(s.status).toBe("channel-not-entitled");
    expect(s.allowedRange).toBeUndefined();
  });

  it("a 403 block wins over an otherwise-ok doc and over a recorded 401", () => {
    expect(
      licenseState(
        gate({
          doc: doc(),
          now: 1500,
          blocked: { reason: "version-too-old" },
        }),
      ).status,
    ).toBe("version-too-old");
    expect(
      licenseState(
        gate({
          doc: doc(),
          now: 1500,
          lastSyncUnauthorized: true,
          blocked: { reason: "version-too-old" },
        }),
      ).status,
    ).toBe("version-too-old");
  });

  it("v3 ordering: an UNACTIVATED install reads needs-activation, not the stale block", () => {
    // v2 checked `blocked` before `hasToken`, so a device with no credential at all rendered
    // "version-too-old". v3 §5 orders the activation guard first: with nothing activated
    // there is no license relationship for a build gate to have blocked, and the actionable
    // state is "activate". The block is re-derived on the next `/license/document` call.
    expect(
      licenseState(
        gate({
          activation: null,
          doc: null,
          now: 1500,
          blocked: { reason: "version-too-old" },
        }),
      ).status,
    ).toBe("needs-activation");
  });

  it("an explicit null blocked hint is the same as no hint", () => {
    expect(
      licenseState(gate({ doc: doc(), now: 1500, blocked: null })).status,
    ).toBe("ok");
  });
});

describe("licenseState — monotonic clock floor (v3 §4.2)", () => {
  it("a floor above graceUntil expires a doc a rolled-back clock would still call ok", () => {
    // The corpus `clockFloorCases` shape: the system clock is wound back inside the
    // document's own window, but the client has re-verified a trust manifest dated after the
    // whole grace window. `max(now, highWaterMark)` is what the gate sees.
    const rolledBack = 1500; // inside [issuedAt, expiresAt] — v2 with no floor read "ok"
    expect(licenseState(gate({ doc: doc(), now: rolledBack })).status).toBe(
      "ok",
    );
    const s = licenseState(
      gate({ doc: doc(), now: rolledBack, highWaterMark: GRACE + 1 }),
    );
    expect(s.status).toBe("expired");
    expect(s.graceUntil).toBe(GRACE);
  });

  it("a floor between expiresAt and graceUntil yields grace, not ok", () => {
    expect(
      licenseState(gate({ doc: doc(), now: 1500, highWaterMark: EXPIRES + 1 }))
        .status,
    ).toBe("grace");
  });

  it("the floor is a minimum: an honest clock past the window is never lowered", () => {
    expect(
      licenseState(gate({ doc: doc(), now: GRACE + 1, highWaterMark: ISSUED }))
        .status,
    ).toBe("expired");
  });

  it("a floor below the system clock is inert", () => {
    expect(
      licenseState(gate({ doc: doc(), now: 1500, highWaterMark: 1 })).status,
    ).toBe("ok");
  });

  it("the document's own issuedAt as the only floor cannot end grace (why trust must feed it)", () => {
    // `floor-config-doc-alone-does-not-stop-rollback`, restated as a gate assertion:
    // issuedAt < graceUntil by construction, so this floor can never reach expiry.
    expect(
      licenseState(gate({ doc: doc(), now: 1500, highWaterMark: ISSUED }))
        .status,
    ).toBe("ok");
  });
});

describe("isUsable", () => {
  it("permits running in ok, grace, and not-applicable only", () => {
    expect(isUsable("ok")).toBe(true);
    expect(isUsable("grace")).toBe(true);
    expect(isUsable("not-applicable")).toBe(true);
    expect(isUsable("expired")).toBe(false);
    expect(isUsable("revoked")).toBe(false);
    expect(isUsable("needs-activation")).toBe(false);
    expect(isUsable("version-too-old")).toBe(false);
    expect(isUsable("version-too-new")).toBe(false);
    expect(isUsable("channel-not-entitled")).toBe(false);
  });

  it("accepts a LicenseState as well as a bare status", () => {
    expect(isUsable(licenseState(gate({ doc: doc(), now: 1500 })))).toBe(true);
    expect(isUsable(licenseState(gate({ activation: null })))).toBe(false);
  });
});
