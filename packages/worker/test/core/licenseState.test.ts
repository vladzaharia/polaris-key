import { describe, expect, it } from "vitest";
import type { LicenseRow } from "../../src/core/repo.js";
import { licenseUsable } from "../../src/core/devices.js";
import {
  licenseState,
  registryAdmits,
  tierDuration,
} from "../../src/core/licensing/duration.js";

const NOW = 1_000_000;
function row(over: Partial<LicenseRow>): LicenseRow {
  return {
    status: "active",
    expires_at: null,
    on_expiry: null,
    fallback_version: null,
    ended_reason: null,
    ...over,
  } as LicenseRow;
}
const PAST = NOW - 10;

describe("licenseState: the plan's section 2.2 table", () => {
  it("active, no expiry: active", () => {
    expect(licenseState(row({}), NOW)).toEqual({
      state: "active",
      usable: true,
      versionCap: null,
      reason: null,
    });
  });
  it("active, not past (any on_expiry, even at the boundary): active", () => {
    for (const on_expiry of [null, "stop", "keepVersion", "tier:free"]) {
      expect(
        licenseState(row({ expires_at: NOW + 5, on_expiry }), NOW).state,
      ).toBe("active");
      expect(licenseState(row({ expires_at: NOW, on_expiry }), NOW).state).toBe(
        "active",
      );
    }
  });
  it("past, on_expiry NULL: expired", () => {
    expect(licenseState(row({ expires_at: PAST }), NOW)).toEqual({
      state: "expired",
      usable: false,
      versionCap: null,
      reason: "expired",
    });
  });
  it("past, stop: expired", () => {
    expect(
      licenseState(row({ expires_at: PAST, on_expiry: "stop" }), NOW).state,
    ).toBe("expired");
  });
  it("past, keepVersion, fallback NULL (tick due): lapsed, no cap", () => {
    expect(
      licenseState(row({ expires_at: PAST, on_expiry: "keepVersion" }), NOW),
    ).toEqual({
      state: "lapsed",
      usable: true,
      versionCap: null,
      reason: null,
    });
  });
  it("past, keepVersion, a version: lapsed with the cap", () => {
    expect(
      licenseState(
        row({
          expires_at: PAST,
          on_expiry: "keepVersion",
          fallback_version: "1.4.0",
        }),
        NOW,
      ),
    ).toEqual({
      state: "lapsed",
      usable: true,
      versionCap: "1.4.0",
      reason: null,
    });
  });
  it("past, keepVersion, '' (none found): expired", () => {
    expect(
      licenseState(
        row({
          expires_at: PAST,
          on_expiry: "keepVersion",
          fallback_version: "",
        }),
        NOW,
      ),
    ).toEqual({
      state: "expired",
      usable: false,
      versionCap: null,
      reason: "expired",
    });
  });
  it("past, tier:<id>: converting", () => {
    expect(
      licenseState(row({ expires_at: PAST, on_expiry: "tier:free" }), NOW),
    ).toEqual({
      state: "converting",
      usable: true,
      versionCap: null,
      reason: null,
    });
  });
  it("a stale fallback_version on any other row is ignored", () => {
    for (const r of [
      row({ fallback_version: "1.0.0" }),
      row({ expires_at: PAST, on_expiry: "stop", fallback_version: "1.0.0" }),
      row({ expires_at: PAST, on_expiry: "tier:x", fallback_version: "1.0.0" }),
      row({
        expires_at: NOW + 9,
        on_expiry: "keepVersion",
        fallback_version: "1.0.0",
      }),
    ]) {
      expect(licenseState(r, NOW).versionCap).toBeNull();
    }
  });
  it("disabled with an ended_reason: ended, that reason", () => {
    for (const reason of [
      "revoked",
      "refunded",
      "chargeback",
      "superseded",
    ] as const) {
      expect(
        licenseState(row({ status: "disabled", ended_reason: reason }), NOW),
      ).toEqual({
        state: "ended",
        usable: false,
        versionCap: null,
        reason,
      });
    }
  });
  it("disabled without an ended_reason: suspended, revoked", () => {
    expect(licenseState(row({ status: "disabled" }), NOW)).toEqual({
      state: "suspended",
      usable: false,
      versionCap: null,
      reason: "revoked",
    });
    expect(
      licenseState(
        row({ status: "disabled", expires_at: PAST, on_expiry: "keepVersion" }),
        NOW,
      ).state,
    ).toBe("suspended");
  });
  it("no row: none, no_license", () => {
    expect(licenseState(null, NOW)).toEqual({
      state: "none",
      usable: false,
      versionCap: null,
      reason: "no_license",
    });
  });
});

describe("registryAdmits", () => {
  it("refuses lapsed and unusable states, admits the rest", () => {
    const lapsed = licenseState(
      row({ expires_at: PAST, on_expiry: "keepVersion" }),
      NOW,
    );
    expect(registryAdmits(lapsed)).toBe(false);
    expect(registryAdmits(licenseState(row({}), NOW))).toBe(true);
    expect(
      registryAdmits(
        licenseState(row({ expires_at: PAST, on_expiry: "tier:a" }), NOW),
      ),
    ).toBe(true);
    expect(registryAdmits(licenseState(null, NOW))).toBe(false);
    expect(registryAdmits(licenseState(row({ expires_at: PAST }), NOW))).toBe(
      false,
    );
  });
});

describe("tierDuration", () => {
  it("matches tierExpiresAt for expires_at and carries on_expiry", () => {
    expect(tierDuration(null, 100)).toEqual({
      expires_at: null,
      on_expiry: null,
    });
    expect(
      tierDuration({ policy_expiry_days: null, on_expiry: "keepVersion" }, 100),
    ).toEqual({
      expires_at: null,
      on_expiry: null,
    });
    expect(
      tierDuration({ policy_expiry_days: 2, on_expiry: null }, 100),
    ).toEqual({
      expires_at: 100 + 2 * 86400,
      on_expiry: null,
    });
    expect(
      tierDuration({ policy_expiry_days: 1, on_expiry: "tier:free" }, 0),
    ).toEqual({
      expires_at: 86400,
      on_expiry: "tier:free",
    });
  });
});

describe("licenseUsable is the old predicate whenever on_expiry is NULL", () => {
  const old = (l: LicenseRow | null, now: number) =>
    !(
      !l ||
      l.status !== "active" ||
      (l.expires_at !== null && now > l.expires_at)
    );
  it("holds over a grid", () => {
    const statuses = ["active", "disabled", "other"];
    const expiries = [null, 0, NOW - 1, NOW, NOW + 1];
    const reasons = [null, "revoked", "refunded"];
    const fallbacks = [null, "", "1.0.0"];
    let n = 0;
    for (const status of statuses)
      for (const expires_at of expiries)
        for (const ended_reason of reasons)
          for (const fallback_version of fallbacks) {
            const l = row({
              status: status as LicenseRow["status"],
              expires_at,
              ended_reason,
              fallback_version,
            });
            expect(licenseUsable(l, NOW)).toBe(old(l, NOW));
            n++;
          }
    expect(licenseUsable(null, NOW)).toBe(false);
    expect(n).toBe(135);
  });
});
