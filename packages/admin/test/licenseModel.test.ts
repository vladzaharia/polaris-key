/**
 * The License pages' pure rules: the computed state (LIC-1), the effective policy and its
 * sources (LIC-4), the minimal PATCH bodies with `null` for a cleared field (LDT-2, TIR-1,
 * TIR-4), and the fingerprint mode mapping (FPP-1).
 */

import { describe, expect, it } from "vitest";
import {
  effectivePolicy,
  licenseState,
  tierSummary,
} from "../src/console/pages/license/shared.js";
import {
  termsPatch,
  type TermsValues,
} from "../src/console/pages/license/LicenseTerms.js";
import {
  EMPTY_TIER,
  tierCreateBody,
  tierPatchBody,
  validateTier,
} from "../src/console/pages/license/TierForm.js";
import {
  createBody,
  validateHolder,
} from "../src/console/pages/license/CreateLicenseDialog.js";
import {
  modeOf,
  policyPatch,
} from "../src/console/pages/license/EnrollmentPage.js";
import { EDU, PRO } from "./licenseFixture.js";

const NOW = Date.UTC(2026, 9, 4, 12);
const S = (ms: number) => Math.floor(ms / 1000);
const DAY = 86_400_000;

describe("licenseState", () => {
  it.each([
    [{ status: "disabled", expiresAt: S(NOW + 100 * DAY) }, "disabled"],
    [{ status: "active", expiresAt: S(NOW - 1000) }, "expired"],
    [{ status: "active", expiresAt: S(NOW + 3 * DAY) }, "expiring"],
    [{ status: "active", expiresAt: S(NOW + 14 * DAY) }, "expiring"],
    [{ status: "active", expiresAt: S(NOW + 15 * DAY) }, "active"],
    [{ status: "active", expiresAt: null }, "active"],
  ] as const)("%o is %s", (license, state) => {
    expect(licenseState(license, NOW)).toBe(state);
  });
});

describe("effectivePolicy", () => {
  const product = { defaultDeviceLimit: 3, defaultMaxOfflineDays: 30 };
  const base = {
    tier: null,
    maxOfflineDays: null,
    channels: [],
    minVersion: null,
    maxVersion: null,
  };
  const line = (lines: ReturnType<typeof effectivePolicy>, label: string) =>
    lines.find((l) => l.label === label)!;

  it("names the product's defaults when nothing else sets a value", () => {
    const lines = effectivePolicy(base, [], product);
    expect(line(lines, "Device limit")).toMatchObject({
      value: "3",
      source: "product",
    });
    expect(line(lines, "Offline")).toMatchObject({
      value: "30 days",
      source: "product",
    });
    expect(line(lines, "Channels")).toMatchObject({
      value: "stable",
      source: "default",
    });
    expect(line(lines, "Versions")).toMatchObject({ value: "Any" });
  });

  it("takes the device limit from the tier only; there is no per-license limit", () => {
    const lines = effectivePolicy({ ...base, tier: "pro" }, [PRO], product);
    expect(line(lines, "Device limit")).toMatchObject({
      value: "5",
      source: "tier",
    });
  });

  it("unions the channels and takes the tighter version bounds", () => {
    const lines = effectivePolicy(
      {
        ...base,
        tier: "pro",
        channels: ["beta"],
        minVersion: "0.9.0",
        maxVersion: "3.0.0",
      },
      [{ ...PRO, maxVersion: "2.0.0" }],
      product,
    );
    expect(line(lines, "Channels").value).toBe("stable, beta");
    // The tier's 1.0.0 floor is higher; the tier's 2.0.0 ceiling is lower.
    expect(line(lines, "Versions").value).toBe("≥ 1.0.0 · ≤ 2.0.0");
  });

  it("calls a non-positive product limit unlimited", () => {
    const lines = effectivePolicy(base, [], {
      ...product,
      defaultDeviceLimit: 0,
    });
    expect(line(lines, "Device limit").value).toBe("Unlimited");
  });

  it("summarizes a tier for pickers", () => {
    expect(tierSummary(PRO)).toBe("365-day term · 5 devices · stable");
    expect(
      tierSummary({ ...EDU, policyExpiryDays: null, policyDeviceLimit: null }),
    ).toBe("No term · product device limit");
  });
});

describe("license bodies", () => {
  const server: TermsValues = {
    tier: "pro",
    expiresAt: NOW + 10 * DAY,
    maxOfflineDays: 14,
    channels: ["stable"],
    minVersion: "1.0.0",
    maxVersion: "",
    profiles: ["a", "b"],
  };

  it("patches only what changed, with null for a cleared field", () => {
    expect(termsPatch(server, { ...server })).toEqual({});
    expect(
      termsPatch(server, {
        ...server,
        maxOfflineDays: null,
        minVersion: "",
        tier: null,
        expiresAt: null,
      }),
    ).toEqual({
      maxOfflineDays: null,
      minVersion: null,
      tier: null,
      expiresAt: null,
    });
    expect(termsPatch(server, { ...server, profiles: ["b", "a"] })).toEqual({
      profiles: ["b", "a"],
    });
    expect(
      termsPatch(server, { ...server, expiresAt: NOW + 20 * DAY + 999 }),
    ).toEqual({ expiresAt: S(NOW + 20 * DAY + 999) });
  });

  it("creates with only what was stated", () => {
    const draft = {
      name: " Ada ",
      email: "ada@x.io",
      tier: null,
      expiryMode: "tier" as const,
      expiresAt: null,
      maxOfflineDays: null,
      channels: [],
      minVersion: "",
      maxVersion: "",
      profiles: [],
    };
    // "The tier's term" with no tier is no expiry.
    expect(createBody(draft)).toEqual({
      name: "Ada",
      email: "ada@x.io",
      expiresAt: null,
    });
    expect(createBody({ ...draft, tier: "pro" })).toEqual({
      name: "Ada",
      email: "ada@x.io",
      tier: "pro",
    });
    expect(validateHolder({ name: "", email: "x" })).toEqual({
      name: "Enter the holder's name.",
      email: "Enter a valid email address.",
    });
  });
});

describe("tier bodies", () => {
  const server = {
    ...EMPTY_TIER,
    id: "pro",
    label: "Pro",
    profile: "base",
    policyExpiryDays: 365,
    policyDeviceLimit: 5,
    channels: ["stable"],
  };

  it("creates without blank numbers and patches null for cleared ones", () => {
    expect(tierCreateBody({ ...EMPTY_TIER, id: "team" })).toEqual({
      id: "team",
      label: "team",
      channels: [],
    });
    expect(
      tierPatchBody(server, {
        ...server,
        profile: null,
        policyDeviceLimit: null,
      }),
    ).toEqual({ profile: null, policyDeviceLimit: null });
    expect(tierPatchBody(server, { ...server })).toEqual({});
  });

  it("validates ids, positive numbers and the version window", () => {
    expect(
      validateTier(
        {
          ...EMPTY_TIER,
          id: "pro",
          policyExpiryDays: 0,
          minVersion: "2.0.0",
          maxVersion: "1.0.0",
        },
        { creating: true, existingIds: ["pro"] },
      ),
    ).toEqual({
      id: "A tier with this id already exists.",
      policyExpiryDays: expect.stringContaining("1 or more"),
      maxVersion: expect.stringContaining("maximum version"),
    });
    expect(
      validateTier({ ...EMPTY_TIER, policyDeviceLimit: 1.5 }),
    ).toHaveProperty("policyDeviceLimit");
  });
});

describe("fingerprint mode", () => {
  it("reads enabled: false as Off and writes Off as enforcement off", () => {
    expect(modeOf({ enabled: false, defaultMode: "strict" })).toBe("off");
    expect(modeOf({ enabled: true, defaultMode: "lenient" })).toBe("lenient");
    expect(policyPatch("off")).toEqual({ enabled: false, defaultMode: "off" });
    expect(policyPatch("normal")).toEqual({
      enabled: true,
      defaultMode: "normal",
    });
  });
});
