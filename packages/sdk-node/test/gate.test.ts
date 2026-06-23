import { describe, expect, it } from "vitest";
import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { licenseState } from "../src/gate.js";

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

describe("licenseState", () => {
  it("needs-enroll without a token", () => {
    expect(licenseState({ hasToken: false, doc: null, now: 1000 }).status).toBe("needs-enroll");
  });
  it("needs-enroll with a token but no doc", () => {
    expect(licenseState({ hasToken: true, doc: null, now: 1000 }).status).toBe("needs-enroll");
  });
  it("revoked on a hard 401", () => {
    expect(licenseState({ hasToken: true, doc: doc(), now: 1000, lastSyncUnauthorized: true }).status).toBe("revoked");
  });
  it("ok within expiry", () => {
    expect(licenseState({ hasToken: true, doc: doc(), now: 1500 }).status).toBe("ok");
  });
  it("grace past expiry but within graceUntil", () => {
    expect(licenseState({ hasToken: true, doc: doc(), now: 1000 + 3601 }).status).toBe("grace");
  });
  it("expired past graceUntil", () => {
    expect(licenseState({ hasToken: true, doc: doc(), now: 1000 + 31 * 86400 }).status).toBe("expired");
  });
  it("reflects a 403 block reason + range", () => {
    const s = licenseState({
      hasToken: true,
      doc: doc(),
      now: 1500,
      blocked: { reason: "version-too-old", allowedRange: { min: "2.0.0" } },
    });
    expect(s.status).toBe("version-too-old");
    expect(s.allowedRange?.min).toBe("2.0.0");
  });
});
