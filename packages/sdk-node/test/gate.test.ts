import { describe, expect, it } from "vitest";
import type { ManagedConfigDoc } from "@plrs/protocol";
import { isUsable, licenseState } from "../src/gate.js";

const ISSUED = 1000;
const EXPIRES = ISSUED + 3600; // 4600
const GRACE = ISSUED + 30 * 86400; // 2_593_000

function doc(over: Partial<ManagedConfigDoc> = {}): ManagedConfigDoc {
  return {
    schemaVersion: 1,
    aud: "djdl",
    iss: "key.plrs.im",
    licenseId: "l",
    deviceId: "d",
    issuedAt: ISSUED,
    expiresAt: EXPIRES,
    graceUntil: GRACE,
    profile: { name: "", firstName: "", email: "", activatedAt: 0 },
    payload: { config: {}, secrets: {}, entitlements: {} },
    ...over,
  };
}

describe("licenseState — activation", () => {
  it("needs-activation without a token", () => {
    expect(
      licenseState({ hasToken: false, doc: null, now: ISSUED }).status,
    ).toBe("needs-activation");
  });
  it("needs-activation with a token but no cached doc", () => {
    expect(
      licenseState({ hasToken: true, doc: null, now: ISSUED }).status,
    ).toBe("needs-activation");
  });
  it("a leftover doc without a token is still needs-activation", () => {
    expect(
      licenseState({ hasToken: false, doc: doc(), now: 1500 }).status,
    ).toBe("needs-activation");
  });
});

describe("licenseState — revoked", () => {
  it("revoked on a hard 401 even with a far-future valid doc", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc({ graceUntil: 9_999_999 }),
      now: 1500,
      lastSyncUnauthorized: true,
    });
    expect(s.status).toBe("revoked");
  });
  it("without the 401 marker the same inputs are ok (proving the marker flips it)", () => {
    expect(
      licenseState({
        hasToken: true,
        doc: doc({ graceUntil: 9_999_999 }),
        now: 1500,
      }).status,
    ).toBe("ok");
  });
});

describe("licenseState — ok / grace / expired boundaries", () => {
  it("ok while now <= expiresAt", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: EXPIRES,
      lastVerifiedAt: 42,
    });
    expect(s.status).toBe("ok");
    expect(s.graceUntil).toBe(GRACE);
    expect(s.lastVerifiedAt).toBe(42);
  });

  it("grace boundary: exactly at expiresAt is still ok, one second past is grace", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: EXPIRES }).status,
    ).toBe("ok");
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: EXPIRES + 1,
      lastVerifiedAt: 7,
    });
    expect(s.status).toBe("grace");
    expect(s.graceUntil).toBe(GRACE);
    expect(s.lastVerifiedAt).toBe(7);
  });

  it("grace persists right up to graceUntil", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: GRACE }).status,
    ).toBe("grace");
  });

  it("expired boundary: exactly at graceUntil is grace, one second past is expired", () => {
    expect(
      licenseState({ hasToken: true, doc: doc(), now: GRACE }).status,
    ).toBe("grace");
    const s = licenseState({ hasToken: true, doc: doc(), now: GRACE + 1 });
    expect(s.status).toBe("expired");
    expect(s.graceUntil).toBe(GRACE);
  });
});

describe("licenseState — blocked (403) takes precedence", () => {
  it("reflects version-too-old + allowedRange", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
    });
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange).toEqual({ min: "2.0.0" });
  });

  it("reflects version-too-new with a max bound", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      blocked: { reason: "version-too-new", allowedRange: { max: "1.0.0" } },
    });
    expect(s.status).toBe("version-too-new");
    expect(s.allowedRange?.max).toBe("1.0.0");
  });

  it("reflects channel-not-entitled (no range)", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      blocked: { reason: "channel-not-entitled" },
    });
    expect(s.status).toBe("channel-not-entitled");
    expect(s.allowedRange).toBeUndefined();
  });

  it("a 403 block wins over an otherwise-ok doc AND over needs-activation", () => {
    expect(
      licenseState({
        hasToken: false,
        doc: null,
        now: 1500,
        blocked: { reason: "version-too-old" },
      }).status,
    ).toBe("version-too-old");
    expect(
      licenseState({
        hasToken: true,
        doc: doc(),
        now: 1500,
        blocked: { reason: "version-too-old" },
      }).status,
    ).toBe("version-too-old");
  });
});

describe("isUsable", () => {
  it("permits running only in ok or grace", () => {
    expect(isUsable("ok")).toBe(true);
    expect(isUsable("grace")).toBe(true);
    expect(isUsable("expired")).toBe(false);
    expect(isUsable("revoked")).toBe(false);
    expect(isUsable("needs-activation")).toBe(false);
    expect(isUsable("version-too-old")).toBe(false);
    expect(isUsable("version-too-new")).toBe(false);
    expect(isUsable("channel-not-entitled")).toBe(false);
  });
});
