/**
 * The License pages' pure rules: the computed state (LIC-1), the effective policy and its
 * sources (LIC-4), the minimal PATCH bodies with `null` for a cleared field (LDT-2, TIR-1,
 * TIR-4), and the fingerprint mode mapping (FPP-1).
 */

import { describe, expect, it } from "vitest";
import { MAX_DEVICE_LIMIT } from "../src/lib/deviceLimit.js";
import {
  effectivePolicy,
  licenseState,
  tierSummary,
} from "../src/console/sections/license/components/shared.js";
import {
  termsPatch,
  type TermsValues,
} from "../src/console/sections/license/pages/LicenseTerms.js";
import {
  EMPTY_TIER,
  tierCreateBody,
  tierPatchBody,
  validateTier,
} from "../src/console/sections/license/components/TierForm.js";
import {
  EMPTY as NEW_EMPTY,
  batchBody,
  createBody,
  csvCell,
  csvOf,
  deliveriesFor,
  deliveryOf,
  loadDraft,
  saveDraft,
  validateHolder,
  validateLimits,
} from "../src/console/sections/license/wizard/draft.js";
import {
  modeOf,
  policyPatch,
} from "../src/console/sections/license/pages/EnrollmentPage.js";
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
      ...NEW_EMPTY,
      name: " Ada ",
      email: " ada@x.io ",
      delivery: "show" as const,
    };
    // "The tier's term" with no tier is no expiry.
    expect(createBody(draft)).toEqual({
      name: "Ada",
      email: "ada@x.io",
      expiresAt: null,
    });
    expect(createBody({ ...draft, tier: "pro", name: "" })).toEqual({
      email: "ada@x.io",
      tier: "pro",
    });
    // The default for someone specific is the email; the limit goes only when set.
    expect(
      createBody({ ...draft, delivery: null, devices: "set", deviceLimit: 4 }),
    ).toEqual({
      name: "Ada",
      email: "ada@x.io",
      expiresAt: null,
      deviceLimit: 4,
      delivery: { email: true },
    });
    expect(validateHolder({ ...NEW_EMPTY, email: "x" })).toEqual({
      email: "Enter a valid email address.",
    });
    expect(validateHolder(NEW_EMPTY)).toEqual({ email: "Enter their email." });
  });

  it("makes a floating key or a labelled batch, and a batch needs a tier", () => {
    const anyone = { ...NEW_EMPTY, who: "anyone" as const };
    expect(createBody(anyone)).toEqual({ expiresAt: null });
    expect(deliveriesFor(anyone)).toEqual(["show", "csv"]);
    const many = { ...anyone, count: 50, label: " Steam, Oct " };
    expect(deliveriesFor(many)).toEqual(["csv"]);
    expect(deliveryOf({ ...many, delivery: "show" })).toBe("csv");
    expect(validateHolder(many)).toEqual({
      tier: "A batch needs a tier. Go back and choose one.",
    });
    expect(validateHolder({ ...many, tier: "pro", label: "" })).toEqual({
      label: "Name the batch.",
    });
    expect(validateHolder({ ...many, tier: "pro", count: 501 })).toEqual({
      count: "Use a whole number from 1 to 500.",
    });
    expect(batchBody({ ...many, tier: "pro", expiryMode: "tier" })).toEqual({
      label: "Steam, Oct",
      count: 50,
      tier: "pro",
    });
  });

  it("checks the limits step", () => {
    expect(
      validateLimits({ ...NEW_EMPTY, devices: "set", deviceLimit: 0 }),
    ).toEqual({ deviceLimit: "Use a whole number from 1 to 1000." });
    expect(
      validateLimits({ ...NEW_EMPTY, devices: "set", deviceLimit: 3 }),
    ).toEqual({});
  });

  it("writes the CSV with escaped cells and no formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(
      csvOf([
        {
          key: "pkey_djdl_AAA",
          licenseId: "lic_1",
          product: "djdl",
          tier: "pro",
          deviceLimit: null,
          expiresAt: 0,
          batch: "Steam, Oct",
        },
      ]),
    ).toBe(
      "key,license_id,product,tier,device_limit,expires_at,batch\r\n" +
        'pkey_djdl_AAA,lic_1,djdl,pro,,1970-01-01T00:00:00.000Z,"Steam, Oct"\r\n',
    );
  });

  it("keeps the draft per product in sessionStorage, and ignores a damaged one", () => {
    window.sessionStorage.clear();
    saveDraft("djdl", { ...NEW_EMPTY, email: "a@x.io", count: 7 });
    expect(loadDraft("djdl")).toMatchObject({ email: "a@x.io", count: 7 });
    expect(loadDraft("other")).toEqual(NEW_EMPTY);
    saveDraft("djdl", NEW_EMPTY);
    expect(window.sessionStorage.getItem("pk-new-license:djdl")).toBeNull();
    window.sessionStorage.setItem("pk-new-license:djdl", "{nope");
    expect(loadDraft("djdl")).toEqual(NEW_EMPTY);
    window.sessionStorage.setItem(
      "pk-new-license:djdl",
      JSON.stringify({ who: 5, channels: "x", count: "3", email: 9 }),
    );
    expect(loadDraft("djdl")).toEqual(NEW_EMPTY);
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
    // The Worker's ceiling holds in the form too: one past it is refused, the ceiling is not.
    expect(
      validateTier({ ...EMPTY_TIER, policyDeviceLimit: MAX_DEVICE_LIMIT + 1 }),
    ).toHaveProperty("policyDeviceLimit");
    expect(
      validateTier({ ...EMPTY_TIER, policyDeviceLimit: MAX_DEVICE_LIMIT }),
    ).not.toHaveProperty("policyDeviceLimit");
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

describe("effectivePolicy uses the Worker's resolver", () => {
  const product = { defaultDeviceLimit: 3, defaultMaxOfflineDays: 30 };
  const input = {
    tier: "pro",
    deviceLimit: 2,
    maxOfflineDays: null,
    channels: [],
    minVersion: null,
    maxVersion: null,
  };
  it("a limit on the license beats the tier's", () => {
    const l = effectivePolicy(input, [PRO], product).find(
      (x) => x.label === "Device limit",
    )!;
    expect(l).toMatchObject({ value: "2", source: "license" });
  });
  it("negative control: without the license limit the tier's applies", () => {
    const l = effectivePolicy(
      { ...input, deviceLimit: null },
      [PRO],
      product,
    ).find((x) => x.label === "Device limit")!;
    expect(l).toMatchObject({ value: "5", source: "tier" });
  });
});
