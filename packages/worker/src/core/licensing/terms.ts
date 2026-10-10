/**
 * LX-32: the one resolver for a licence's limits and duration (UI word: Limits).
 *
 * Every limit a licence carries is resolved here and nowhere else, and each resolved field
 * reports where its value came from. The chain is the licence's own value, else the tier's, else
 * the platform (product) default; the exceptions are today's behaviour, kept exactly:
 *
 *   deviceLimit      licence, else tier, else a merged `deviceLimit` entitlement, else product
 *   maxOfflineDays   licence, else product (a tier's grace is stored for LX-09 and not read yet)
 *   channels         the union of the tier's and the licence's; none means stable only
 *   minVersion       the tighter (higher) of the tier's and the licence's
 *   maxVersion       the tighter (lower) of the tier's and the licence's
 *   fingerprintMode  the tier's, else the product default; "off" when the product opts out
 *
 * The module is PURE and imports nothing, so the Worker (documents, seat enforcement, admin and
 * portal reads) and the console's live preview of an unsaved form share this one implementation.
 * The version comparators are passed in for the same reason `injectAdminPolicy` takes them.
 */

export type TermSource = "license" | "tier" | "entitlement" | "product";

export interface Sourced<T, S extends string = TermSource> {
  value: T;
  source: S;
}

/** What a licence sets itself; `null` / empty means "inherit". */
export interface LicenseTermsLicense {
  deviceLimit: number | null;
  maxOfflineDays: number | null;
  channels: readonly string[];
  minVersion: string | null;
  maxVersion: string | null;
}

/** What a tier sets; `null` / empty means "none". */
export interface LicenseTermsTier {
  deviceLimit: number | null;
  channels: readonly string[];
  minVersion: string | null;
  maxVersion: string | null;
  /** The tier's raw fingerprint policy; an unknown value counts as unset. */
  fingerprintMode: string | null;
}

export interface LicenseTermsProduct {
  deviceLimit: number;
  maxOfflineDays: number;
  /** Absent: the caller does not resolve a fingerprint mode. */
  fingerprint?: { enabled: boolean; defaultMode: string | null };
}

export interface LicenseTermsInput {
  license: LicenseTermsLicense;
  tier: LicenseTermsTier | null;
  /** A `deviceLimit` entitlement merged from a profile, store grant or override. */
  entitlementDeviceLimit?: number | null;
  product: LicenseTermsProduct;
  /** The tighter (higher) minimum, as `core/licensing/entitlements.ts` `tighterMin`. */
  minOf: (a?: string, b?: string) => string | undefined;
  /** The tighter (lower) maximum, as `tighterMax`. */
  maxOf: (a?: string, b?: string) => string | undefined;
}

export type FingerprintModeValue = "off" | "lenient" | "normal" | "strict";

export interface LicenseTerms {
  deviceLimit: Sourced<number>;
  /** What the limit would be without the licence's own value ("Use inherited limit"). */
  inheritedDeviceLimit: Sourced<number, Exclude<TermSource, "license">>;
  maxOfflineDays: Sourced<number, "license" | "product">;
  /** Empty value: stable only. `both` is the union of the licence's and the tier's. */
  channels: Sourced<string[], "license" | "tier" | "both" | "none">;
  minVersion: Sourced<string | null, "license" | "tier" | "none">;
  maxVersion: Sourced<string | null, "license" | "tier" | "none">;
  fingerprintMode: Sourced<FingerprintModeValue, "tier" | "product" | "off">;
}

const MODES: readonly string[] = ["off", "lenient", "normal", "strict"];

function isMode(v: unknown): v is FingerprintModeValue {
  return typeof v === "string" && MODES.includes(v);
}

function isLimit(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function tighterSource(
  own: string | null,
  tier: string | null,
  pick: (a?: string, b?: string) => string | undefined,
): Sourced<string | null, "license" | "tier" | "none"> {
  const value = pick(tier ?? undefined, own ?? undefined) ?? null;
  if (value === null) return { value: null, source: "none" };
  // Ties and unparseable pairs resolve to the tier's, the first argument, as the gate does.
  return { value, source: value === tier ? "tier" : "license" };
}

export function resolveLicenseTerms(i: LicenseTermsInput): LicenseTerms {
  const { license, tier, product } = i;
  const tierLimit =
    tier && typeof tier.deviceLimit === "number" ? tier.deviceLimit : null;
  const ent =
    typeof i.entitlementDeviceLimit === "number"
      ? i.entitlementDeviceLimit
      : null;

  const inheritedDeviceLimit: LicenseTerms["inheritedDeviceLimit"] =
    tierLimit !== null
      ? { value: tierLimit, source: "tier" }
      : ent !== null
        ? { value: ent, source: "entitlement" }
        : { value: product.deviceLimit, source: "product" };
  const deviceLimit: LicenseTerms["deviceLimit"] = isLimit(license.deviceLimit)
    ? { value: license.deviceLimit, source: "license" }
    : inheritedDeviceLimit;

  const maxOfflineDays: LicenseTerms["maxOfflineDays"] =
    license.maxOfflineDays != null
      ? { value: license.maxOfflineDays, source: "license" }
      : { value: product.maxOfflineDays, source: "product" };

  const tierChannels = tier?.channels ?? [];
  const channels = [...new Set([...tierChannels, ...license.channels])];
  const channelSource: LicenseTerms["channels"]["source"] =
    channels.length === 0
      ? "none"
      : license.channels.length && tierChannels.length
        ? "both"
        : license.channels.length
          ? "license"
          : "tier";

  const fp = product.fingerprint;
  const tierMode = tier?.fingerprintMode;
  const fingerprintMode: LicenseTerms["fingerprintMode"] =
    fp && !fp.enabled
      ? { value: "off", source: "off" }
      : isMode(tierMode)
        ? { value: tierMode, source: "tier" }
        : {
            value: isMode(fp?.defaultMode) ? fp.defaultMode : "normal",
            source: "product",
          };

  return {
    deviceLimit,
    inheritedDeviceLimit,
    maxOfflineDays,
    channels: { value: channels, source: channelSource },
    minVersion: tighterSource(
      license.minVersion,
      tier?.minVersion ?? null,
      i.minOf,
    ),
    maxVersion: tighterSource(
      license.maxVersion,
      tier?.maxVersion ?? null,
      i.maxOf,
    ),
    fingerprintMode,
  };
}
