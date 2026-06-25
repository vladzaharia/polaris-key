import { describe, expect, it } from "vitest";
import type { LicenseStatus, ManagedConfigDoc } from "@polaris-key/protocol";
import { isUsable, licenseState } from "../src/core/gateModel.js";
import type { GateInput } from "../src/core/gateModel.js";

// The full licenseState decision matrix. gateModel.test.ts covers the happy transitions;
// this file pins down the *precedence* between the competing inputs (block > no-token > 401 >
// doc presence > grace/expiry) plus the metadata each branch is required to carry. Times are
// epoch seconds, matching the signed doc.

function doc(over: Partial<ManagedConfigDoc> = {}): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "l",
    deviceId: "d",
    issuedAt: 1000,
    expiresAt: 1000 + 3600,
    graceUntil: 1000 + 30 * 86400,
    profile: { name: "", firstName: "", email: "", enrolledAt: 0 },
    payload: { config: {}, secrets: {}, entitlements: {} },
    ...over,
  };
}

describe("licenseState precedence", () => {
  it("a 403 block wins over everything — even a valid doc and no token", () => {
    const s = licenseState({
      hasToken: false,
      doc: doc(),
      now: 1500,
      lastSyncUnauthorized: true,
      blocked: { reason: "channel-not-entitled" },
    });
    expect(s.status).toBe("channel-not-entitled");
  });

  it("missing credential beats a hard 401 (no token ⇒ needs-enroll, not revoked)", () => {
    const s = licenseState({
      hasToken: false,
      doc: doc(),
      now: 1500,
      lastSyncUnauthorized: true,
    });
    expect(s.status).toBe("needs-enroll");
  });

  it("a hard 401 beats doc presence (token + doc + 401 ⇒ revoked)", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      lastSyncUnauthorized: true,
    });
    expect(s.status).toBe("revoked");
  });

  it("token present but no doc ⇒ needs-enroll (not error)", () => {
    expect(licenseState({ hasToken: true, doc: null, now: 1500 }).status).toBe(
      "needs-enroll",
    );
  });
});

describe("licenseState metadata carried per branch", () => {
  it("ok carries graceUntil + lastVerifiedAt and no allowedRange", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      lastVerifiedAt: 1500,
    });
    expect(s).toMatchObject({
      status: "ok",
      graceUntil: 1000 + 30 * 86400,
      lastVerifiedAt: 1500,
    });
    expect(s.allowedRange).toBeUndefined();
  });

  it("grace carries graceUntil + lastVerifiedAt", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1000 + 3601,
      lastVerifiedAt: 4600,
    });
    expect(s).toMatchObject({
      status: "grace",
      graceUntil: 1000 + 30 * 86400,
      lastVerifiedAt: 4600,
    });
  });

  it("expired carries graceUntil but drops lastVerifiedAt", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1000 + 31 * 86400,
      lastVerifiedAt: 999,
    });
    expect(s.status).toBe("expired");
    expect(s.graceUntil).toBe(1000 + 30 * 86400);
    expect(s.lastVerifiedAt).toBeUndefined();
  });

  it("a block surfaces the reason + the allowedRange verbatim", () => {
    const range = { min: "2.0.0", max: "3.0.0" };
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      blocked: { reason: "version-too-new", allowedRange: range },
    });
    expect(s.status).toBe("version-too-new");
    expect(s.allowedRange).toEqual(range);
  });

  it("needs-enroll carries no grace/range metadata", () => {
    const s = licenseState({ hasToken: false, doc: null, now: 1500 });
    expect(s).toEqual({ status: "needs-enroll" });
  });
});

describe("licenseState boundary conditions", () => {
  it("exactly at expiresAt is still ok (strict > comparison)", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: 1000 + 3600 }).status,
    ).toBe("ok");
  });

  it("one second past expiresAt is grace", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: 1000 + 3601 }).status,
    ).toBe("grace");
  });

  it("exactly at graceUntil is still grace", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: 1000 + 30 * 86400 })
        .status,
    ).toBe("grace");
  });

  it("one second past graceUntil is expired", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: 1000 + 30 * 86400 + 1 })
        .status,
    ).toBe("expired");
  });
});

describe("isUsable over the full status set", () => {
  const usable: LicenseStatus[] = ["ok", "grace"];
  const all: LicenseStatus[] = [
    "ok",
    "grace",
    "expired",
    "revoked",
    "needs-enroll",
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
  ];
  for (const status of all) {
    it(`${status} is ${usable.includes(status) ? "usable" : "blocked"}`, () => {
      expect(isUsable(status)).toBe(usable.includes(status));
    });
  }
});

describe("all three block reasons propagate", () => {
  for (const reason of [
    "version-too-old",
    "version-too-new",
    "channel-not-entitled",
  ] as const) {
    it(`reason ${reason} maps straight through to status`, () => {
      const input: GateInput = {
        hasToken: true,
        doc: doc(),
        now: 1500,
        blocked: { reason },
      };
      expect(licenseState(input).status).toBe(reason);
    });
  }
});
