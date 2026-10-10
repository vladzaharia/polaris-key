/**
 * LX-32: one resolver for a licence's limits and duration.
 *
 * Three things are pinned: the resolver's per-field sources, that it is behaviour-preserving
 * (the entitlements the signed documents carry are produced exactly as the pre-resolver rules
 * produced them, over a matrix of inputs), and that no second implementation of the chain exists.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  injectAdminPolicy,
  licenseOwnDeviceLimit,
  licenseTermsOf,
  tierDeviceLimit,
  tighterMax,
  tighterMin,
} from "../src/core/entitlements.js";
import { resolveLicenseTerms } from "../src/core/licensing/terms.js";
import type { LicenseRow, TierRow } from "../src/core/data.js";
import type { ManagedPayload } from "../src/core/payload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

const license = (o: Partial<LicenseRow> = {}): LicenseRow =>
  ({
    id: "l1",
    tier_id: null,
    modified_at: 1000,
    device_limit: null,
    max_offline_days: null,
    channels_json: null,
    min_version: null,
    max_version: null,
    ...o,
  }) as unknown as LicenseRow;
const tier = (o: Partial<TierRow> = {}): TierRow =>
  ({
    id: "pro",
    label: "Pro",
    policy_device_limit: null,
    channels_json: null,
    min_version: null,
    max_version: null,
    policy_fingerprint: null,
    ...o,
  }) as unknown as TierRow;
const product = {
  defaultDeviceLimit: 3,
  defaultMaxOfflineDays: 30,
  fingerprintPolicy: { enabled: true, defaultMode: "normal" },
};

describe("resolveLicenseTerms sources", () => {
  it("falls to the platform default when nothing else sets a value", () => {
    const t = licenseTermsOf(license(), null, product);
    expect(t.deviceLimit).toEqual({ value: 3, source: "product" });
    expect(t.maxOfflineDays).toEqual({ value: 30, source: "product" });
    expect(t.channels).toEqual({ value: [], source: "none" });
    expect(t.minVersion).toEqual({ value: null, source: "none" });
    expect(t.fingerprintMode).toEqual({ value: "normal", source: "product" });
  });

  it("licence beats tier beats entitlement beats the platform default", () => {
    const tr = tier({ policy_device_limit: 5 });
    expect(
      licenseTermsOf(license({ device_limit: 2 }), tr, product, 9).deviceLimit,
    ).toEqual({
      value: 2,
      source: "license",
    });
    expect(licenseTermsOf(license(), tr, product, 9).deviceLimit).toEqual({
      value: 5,
      source: "tier",
    });
    expect(licenseTermsOf(license(), tier(), product, 9).deviceLimit).toEqual({
      value: 9,
      source: "entitlement",
    });
    // The inherited value ignores the licence's own limit.
    expect(
      licenseTermsOf(license({ device_limit: 2 }), tr, product)
        .inheritedDeviceLimit,
    ).toEqual({ value: 5, source: "tier" });
  });

  it("duration: the licence's offline days, else the product's (a tier's is not read yet)", () => {
    expect(
      licenseTermsOf(license({ max_offline_days: 7 }), null, product)
        .maxOfflineDays,
    ).toEqual({
      value: 7,
      source: "license",
    });
    expect(
      licenseTermsOf(license(), tier(), product).maxOfflineDays.source,
    ).toBe("product");
  });

  it("channels union with a source; versions take the tighter bound", () => {
    const t = licenseTermsOf(
      license({
        channels_json: '["beta"]',
        min_version: "0.9.0",
        max_version: "3.0.0",
      }),
      tier({
        channels_json: '["stable"]',
        min_version: "1.0.0",
        max_version: "2.0.0",
      }),
      product,
    );
    expect(t.channels).toEqual({ value: ["stable", "beta"], source: "both" });
    expect(t.minVersion).toEqual({ value: "1.0.0", source: "tier" });
    expect(t.maxVersion).toEqual({ value: "2.0.0", source: "tier" });
    const own = licenseTermsOf(
      license({ min_version: "2.0.0" }),
      tier({ min_version: "1.0.0" }),
      product,
    );
    expect(own.minVersion).toEqual({ value: "2.0.0", source: "license" });
  });

  it("fingerprint: tier policy, else product default, off when the product opts out", () => {
    expect(
      licenseTermsOf(null, tier({ policy_fingerprint: "strict" }), product)
        .fingerprintMode,
    ).toEqual({
      value: "strict",
      source: "tier",
    });
    expect(
      licenseTermsOf(null, tier({ policy_fingerprint: "bogus" }), product)
        .fingerprintMode.source,
    ).toBe("product");
    expect(
      licenseTermsOf(null, tier({ policy_fingerprint: "strict" }), {
        ...product,
        fingerprintPolicy: { enabled: false, defaultMode: "normal" },
      }).fingerprintMode,
    ).toEqual({ value: "off", source: "off" });
  });

  it("negative control: a wrong chain order fails the assertions above", () => {
    const wrong = resolveLicenseTerms({
      license: {
        deviceLimit: 2,
        maxOfflineDays: null,
        channels: [],
        minVersion: null,
        maxVersion: null,
      },
      tier: {
        deviceLimit: 5,
        channels: [],
        minVersion: null,
        maxVersion: null,
        fingerprintMode: null,
      },
      product: { deviceLimit: 3, maxOfflineDays: 30 },
      minOf: tighterMin,
      maxOf: tighterMax,
    });
    expect(wrong.deviceLimit.source).not.toBe("tier");
  });
});

/** The pre-resolver `injectAdminPolicy` entitlement rules, kept verbatim as the oracle. */
function legacyStamp(
  t: TierRow | null,
  l: LicenseRow,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parse = (j: string | null): string[] => {
    if (!j) return [];
    try {
      const v = JSON.parse(j);
      return Array.isArray(v) ? v.filter((c) => typeof c === "string") : [];
    } catch {
      return [];
    }
  };
  const channels = [
    ...new Set([...parse(t?.channels_json ?? null), ...parse(l.channels_json)]),
  ];
  if (channels.length > 0) out["channels"] = channels;
  const dl = licenseOwnDeviceLimit(l) ?? tierDeviceLimit(t);
  if (dl !== null) out["deviceLimit"] = dl;
  const min = tighterMin(
    t?.min_version ?? undefined,
    l.min_version ?? undefined,
  );
  if (min) out["app.minVersion"] = min;
  const max = tighterMax(
    t?.max_version ?? undefined,
    l.max_version ?? undefined,
  );
  if (max) out["app.maxVersion"] = max;
  return out;
}

describe("signed-document entitlements are byte-identical to the pre-resolver rules", () => {
  const tiers: (TierRow | null)[] = [
    null,
    tier(),
    tier({
      policy_device_limit: 5,
      channels_json: '["stable","beta"]',
      min_version: "1.0.0",
      max_version: "2.0.0",
    }),
    tier({ channels_json: "not json", min_version: "1.0.0-rc.1" }),
  ];
  const licenses: LicenseRow[] = [
    license(),
    license({ device_limit: 2 }),
    license({ device_limit: 0 }),
    license({
      channels_json: '["beta","dev"]',
      min_version: "1.0.0",
      max_version: "9.0.0",
    }),
    license({
      min_version: "0.1.0",
      max_version: "1.5.0",
      channels_json: "[]",
    }),
    license({ min_version: "garbage", max_version: "garbage" }),
  ];
  for (const [ti, t] of tiers.entries())
    for (const [li, l] of licenses.entries())
      it(`tier ${ti} x licence ${li}`, () => {
        const payload = { entitlements: {} } as unknown as ManagedPayload;
        injectAdminPolicy(payload, t, l, tighterMin, tighterMax);
        const got: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(payload.entitlements)) {
          if (k.startsWith("license.")) continue;
          got[k] = (v as { value: unknown }).value;
        }
        expect(JSON.stringify(got)).toBe(JSON.stringify(legacyStamp(t, l)));
      });
});

/** The pre-resolver rules for the remaining fields, as the oracle. */
const legacyOffline = (l: LicenseRow, p: number) => l.max_offline_days ?? p;
const legacyFingerprint = (
  t: TierRow | null,
  fp: { enabled: boolean; defaultMode: string },
) => {
  const ok = (v: unknown) =>
    v === "off" || v === "lenient" || v === "normal" || v === "strict";
  if (!fp.enabled) return "off";
  if (ok(t?.policy_fingerprint)) return t!.policy_fingerprint;
  if (ok(fp.defaultMode)) return fp.defaultMode;
  return "normal";
};
const legacyLimit = (
  t: TierRow | null,
  l: LicenseRow,
  ent: number | null,
  pd: number,
) => {
  const inherited =
    tierDeviceLimit(t) !== null
      ? { limit: tierDeviceLimit(t), source: "tier" }
      : ent !== null
        ? { limit: ent, source: "entitlement" }
        : { limit: pd, source: "product" };
  const own = licenseOwnDeviceLimit(l);
  return own !== null
    ? { limit: own, source: "license", inherited }
    : { ...inherited, inherited };
};

describe("offline days, device limit info and fingerprint mode match the old rules", () => {
  const modes = [null, "off", "lenient", "normal", "strict", "bogus"];
  const defaults = ["off", "lenient", "normal", "strict"];
  const tiersM = modes.flatMap((m) =>
    [null, 4].map((d) =>
      tier({ policy_fingerprint: m, policy_device_limit: d }),
    ),
  );
  const licM = [null, 0, 2].flatMap((d) =>
    [null, 7].map((o) => license({ device_limit: d, max_offline_days: o })),
  );
  it("matches over the whole matrix", () => {
    for (const t of [null, ...tiersM])
      for (const l of licM)
        for (const ent of [null, 9])
          for (const enabled of [true, false])
            for (const dm of defaults) {
              const fp = { enabled, defaultMode: dm };
              const prod = {
                defaultDeviceLimit: 3,
                defaultMaxOfflineDays: 30,
                fingerprintPolicy: fp,
              };
              const r = licenseTermsOf(l, t, prod, ent);
              expect(r.maxOfflineDays.value).toBe(legacyOffline(l, 30));
              expect(r.fingerprintMode.value).toBe(legacyFingerprint(t, fp));
              const old = legacyLimit(t, l, ent, 3);
              expect({
                limit: r.deviceLimit.value,
                source: r.deviceLimit.source,
                inherited: {
                  limit: r.inheritedDeviceLimit.value,
                  source: r.inheritedDeviceLimit.source,
                },
              }).toEqual(old);
            }
  });
  it("lenient: tier, product default, and opt-out wins", () => {
    const fp = (enabled: boolean, defaultMode: string) => ({
      ...product,
      fingerprintPolicy: { enabled, defaultMode },
    });
    expect(
      licenseTermsOf(
        null,
        tier({ policy_fingerprint: "lenient" }),
        fp(true, "strict"),
      ).fingerprintMode,
    ).toEqual({ value: "lenient", source: "tier" });
    expect(
      licenseTermsOf(null, tier(), fp(true, "lenient")).fingerprintMode,
    ).toEqual({
      value: "lenient",
      source: "product",
    });
    expect(
      licenseTermsOf(
        null,
        tier({ policy_fingerprint: "lenient" }),
        fp(false, "strict"),
      ).fingerprintMode.value,
    ).toBe("off");
  });
});

describe("one terms implementation", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts")) out.push(p);
    }
    return out;
  }
  const files = walk(SRC);
  const allowed = [join("core", "licensing", "terms.ts")];

  it("no source outside the resolver coalesces a licence limit with a default", () => {
    const patterns = [
      /max_offline_days\s*\?\?/,
      /\?\?\s*product\.defaultMaxOfflineDays/,
      /\?\?\s*product\.defaultDeviceLimit/,
      /\?\?\s*p\.defaultMaxOfflineDays/,
      /\?\?\s*p\.defaultDeviceLimit/,
      /license\.device_limit\s*\?\?(?!\s*(?:null\b|"inherit"))/,
      /licenseOwnDeviceLimit\([^)]*\)\s*\?\?/,
    ];
    const hits: string[] = [];
    for (const f of files) {
      if (allowed.some((a) => f.endsWith(a))) continue;
      const text = readFileSync(f, "utf8");
      for (const re of patterns) if (re.test(text)) hits.push(`${f}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("negative control: the scan does catch the old inline rule", () => {
    const old =
      "valid.license.max_offline_days ?? product.defaultMaxOfflineDays";
    expect(/max_offline_days\s*\?\?/.test(old)).toBe(true);
  });

  it("the console has no copy of the chain", () => {
    const shared = readFileSync(
      join(
        HERE,
        "..",
        "..",
        "admin",
        "src",
        "console",
        "sections",
        "license",
        "components",
        "shared.tsx",
      ),
      "utf8",
    );
    expect(shared).toContain("core/licensing/terms.js");
    expect(shared).not.toMatch(/function tighter\(/);
  });
});
