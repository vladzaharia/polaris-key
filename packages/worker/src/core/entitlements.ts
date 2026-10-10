/**
 * The entitlement algebra — semver comparison, the version window, and which release channels a
 * grant covers.
 *
 * ── WHY THIS IS IN CORE ─────────────────────────────────────────────────────────────────────
 *
 * Two services now ask the same question of the same rows. License asks it to decide whether a
 * build may have a document at all (`checkBuildGate`); Release and Update ask it under the
 * `entitled` access mode (D-13) to decide whether this caller may see a beta feed or download a
 * pinned artifact. They must agree — a client refused a beta document but handed the beta DMG
 * is not a policy, it is a bug — and they may not import each other (`test/boundaries.test.ts`).
 *
 * So the computation lives here, once, and both sides bind to it. `services/license/gate.ts`
 * re-exports the comparators it always exported, so every existing importer is unchanged;
 * `services/license/entitlements.ts` re-exports `injectAdminPolicy` for the same reason.
 *
 * Everything in this file is PURE: rows and maps in, values out. No I/O, no clock, no `Env`.
 */

import type { AllowedRange, ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "./payload.js";
import type { LicenseRow, TierRow } from "./data.js";
import { resolveLicenseTerms, type LicenseTerms } from "./licensing/terms.js";

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(v: string): ParsedSemver | null {
  const m = v.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

/** Semver compare. Returns -1, 0, 1. Unparseable inputs compare equal (0). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length > 0) return 1;
  if (pa.prerelease.length > 0 && pb.prerelease.length === 0) return -1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The tighter (higher) of two minimums. */
export function tighterMin(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) >= 0 ? a : b;
}

/** The tighter (lower) of two maximums. */
export function tighterMax(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSemver(a, b) <= 0 ? a : b;
}

function strEnt(e: ManagedEntry | undefined): string | undefined {
  return e && typeof e.value === "string" ? e.value : undefined;
}

function arrEnt(e: ManagedEntry | undefined): string[] | undefined {
  return e && Array.isArray(e.value)
    ? (e.value.filter((v) => typeof v === "string") as string[])
    : undefined;
}

/**
 * Which channels a grant is entitled to. Absent === stable only.
 *
 * `stable` being the floor is not an accident of this default: it is the rule the whole channel
 * model rests on. Every licence holds it, so a product that has never authored a `channels`
 * entitlement still serves its shipping release to everybody.
 */
export function entitledChannels(
  entitlements: Record<string, ManagedEntry>,
): string[] {
  return arrEnt(entitlements["channels"]) ?? ["stable"];
}

/**
 * The effective version window: the product's compat range intersected with the grant's own
 * `app.minVersion`/`app.maxVersion`. Tighter always wins, in both directions.
 */
export function versionWindow(
  entitlements: Record<string, ManagedEntry>,
  compatMin: string,
  compatMax: string,
): AllowedRange {
  const min = tighterMin(compatMin, strEnt(entitlements["app.minVersion"]));
  const max = tighterMax(compatMax, strEnt(entitlements["app.maxVersion"]));
  const range: AllowedRange = {};
  if (min) range.min = min;
  if (max) range.max = max;
  return range;
}

/** Does the window actually restrict? A max always does; a min only when it is above the
 *  `0.0.0` floor every product defaults to (`compat_min NOT NULL DEFAULT '0.0.0'`), so the
 *  default window is open. */
export function windowBounded(range: AllowedRange): boolean {
  if (range.max) return true;
  if (!range.min) return false;
  const p = parseSemver(range.min);
  return !(
    p &&
    p.major === 0 &&
    p.minor === 0 &&
    p.patch === 0 &&
    p.prerelease.length === 0
  );
}

/** Is `version` inside `range`? `compareSemver` calls an unparseable version equal to every
 *  bound, so a truly bounded window refuses a version it cannot order; an open
 *  window (no max, min absent or 0.0.0) admits anything, as before. */
export function versionInWindow(version: string, range: AllowedRange): boolean {
  if (windowBounded(range) && !parseSemver(version)) return false;
  if (range.min && compareSemver(version, range.min) < 0) return false;
  if (range.max && compareSemver(version, range.max) > 0) return false;
  return true;
}

/** Parse a JSON string-array column, ignoring null/invalid. */
function parseChannelsJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v)
      ? (v.filter((c) => typeof c === "string") as string[])
      : [];
  } catch {
    return [];
  }
}

/** The licence's own seat limit (`licenses.device_limit`, LX-14a), or null to inherit. */
export function licenseOwnDeviceLimit(
  license: Pick<LicenseRow, "device_limit">,
): number | null {
  const v = license.device_limit;
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

/** The tier's seat limit (`tiers.policy_device_limit`), or null when it sets none. */
export function tierDeviceLimit(
  tier: Pick<TierRow, "policy_device_limit"> | null | undefined,
): number | null {
  const v = tier?.policy_device_limit;
  return typeof v === "number" ? v : null;
}

/**
 * Inject the admin upgrade-channel + version-window policy (from the tier and license rows)
 * as ENFORCED entitlements, so the existing gate governs them with no gate-logic changes.
 *
 * The comparator parameters stay explicit rather than closing over the pair above: the legacy
 * `licenseCore.resolveEffective` passes its caller's pair, and taking them as arguments is what
 * let this function move without changing a single one of those call sites.
 *
 * It lives in Core because the `entitled` access mode has to produce exactly the same
 * entitlement map the license document would carry (see the file header) — running a SECOND,
 * row-only derivation next door would quietly ignore channels authored in a profile or an
 * override, and the two answers would drift the first time somebody used one.
 */
export function injectAdminPolicy(
  payload: ManagedPayload,
  tier: TierRow | null,
  license: LicenseRow,
  minOf: (a?: string, b?: string) => string | undefined,
  maxOf: (a?: string, b?: string) => string | undefined,
): void {
  const updatedAt = license.modified_at;
  const enforced = (value: ManagedEntry["value"]): ManagedEntry => ({
    state: "enforced",
    value,
    updatedAt,
  });

  // The license's plan, surfaced to the client as ordinary entitlements. This is what makes
  // remote re-licensing visible without touching the signed document's shape: changing
  // `licenses.tier_id` bumps `modified_at`, which changes these entries' `updatedAt`, which
  // changes the doc's ETag — so the client's next refresh detects a real content change.
  if (license.tier_id) {
    payload.entitlements["license.tier"] = enforced(license.tier_id);
    if (tier?.label) {
      payload.entitlements["license.tierLabel"] = enforced(tier.label);
    }
  }

  // LX-32: one resolver decides every limit; this only stamps what it resolved. The device limit
  // is stamped only when the licence or its tier sets one, so a merged `deviceLimit` entitlement
  // (a profile, store grant or override) keeps its place below them (LX-14a).
  const terms = licenseTermsOf(license, tier, { defaultDeviceLimit: 0 }, null, {
    minOf,
    maxOf,
  });
  if (terms.channels.value.length > 0)
    payload.entitlements["channels"] = enforced(terms.channels.value);

  if (
    terms.deviceLimit.source === "license" ||
    terms.deviceLimit.source === "tier"
  )
    payload.entitlements["deviceLimit"] = enforced(terms.deviceLimit.value);

  if (terms.minVersion.value)
    payload.entitlements["app.minVersion"] = enforced(terms.minVersion.value);
  if (terms.maxVersion.value)
    payload.entitlements["app.maxVersion"] = enforced(terms.maxVersion.value);
}

/** A licence that sets nothing itself. */
const NO_OWN_TERMS = {
  device_limit: null,
  max_offline_days: null,
  channels_json: null,
  min_version: null,
  max_version: null,
} as const;

/**
 * LX-32: the resolved Limits of a licence row on a tier row (`core/licensing/terms.ts`), with
 * the Worker's comparators. Every reader of a licence's limits goes through this one call.
 * `product` needs only what the caller reads: the seat paths pass the device default alone, the
 * documents add the offline default, the fingerprint path adds its policy.
 */
export function licenseTermsOf(
  /** `null`: no licence (a keyless device, or a read of the tier and platform layers alone). */
  license: Pick<
    LicenseRow,
    | "device_limit"
    | "max_offline_days"
    | "channels_json"
    | "min_version"
    | "max_version"
  > | null,
  tier: Pick<
    TierRow,
    | "policy_device_limit"
    | "channels_json"
    | "min_version"
    | "max_version"
    | "policy_fingerprint"
  > | null,
  product: {
    defaultDeviceLimit: number;
    defaultMaxOfflineDays?: number;
    fingerprintPolicy?: { enabled: boolean; defaultMode: string | null };
  },
  entitlementDeviceLimit?: number | null,
  /** The version comparators; `injectAdminPolicy` forwards its caller's pair. */
  cmp: {
    minOf: (a?: string, b?: string) => string | undefined;
    maxOf: (a?: string, b?: string) => string | undefined;
  } = { minOf: tighterMin, maxOf: tighterMax },
): LicenseTerms {
  if (!license) license = NO_OWN_TERMS;
  return resolveLicenseTerms({
    license: {
      deviceLimit: licenseOwnDeviceLimit(license),
      maxOfflineDays: license.max_offline_days,
      channels: parseChannelsJson(license.channels_json),
      minVersion: license.min_version,
      maxVersion: license.max_version,
    },
    tier: tier
      ? {
          deviceLimit: tierDeviceLimit(tier),
          channels: parseChannelsJson(tier.channels_json),
          minVersion: tier.min_version,
          maxVersion: tier.max_version,
          fingerprintMode: tier.policy_fingerprint ?? null,
        }
      : null,
    entitlementDeviceLimit,
    product: {
      deviceLimit: product.defaultDeviceLimit,
      maxOfflineDays: product.defaultMaxOfflineDays ?? 0,
      fingerprint: product.fingerprintPolicy,
    },
    minOf: cmp.minOf,
    maxOf: cmp.maxOf,
  });
}
