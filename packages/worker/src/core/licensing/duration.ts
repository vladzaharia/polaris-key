/**
 * LX-41.3: what a licence's term means right now. `licenseState` is a pure function of ONE licence
 * row and a clock (plans/LX-41.md §2.2): it reads `status`, `expires_at`, `on_expiry`,
 * `fallback_version` and `ended_reason`, never a tier or a subscription. Writers of the term land in
 * LX-41.4; this module has no I/O and imports types only.
 */
import type { LicenseRow, TierRow } from "../repo.js";

/** What a licence does at its end: stop, keep the last covered version, or convert to a tier. */
export type OnExpiry = "stop" | "keepVersion" | `tier:${string}`;

export type LicenseStateName =
  | "active"
  | "lapsed"
  | "converting"
  | "expired"
  | "ended"
  | "suspended"
  | "none";

export type LicenseStateReason =
  | "no_license"
  | "expired"
  | "revoked"
  | "refunded"
  | "chargeback"
  | "superseded";

export interface LicenseState {
  state: LicenseStateName;
  usable: boolean;
  /** A lapsed `keepVersion` licence with a frozen version: that version. Otherwise null. */
  versionCap: string | null;
  reason: LicenseStateReason | null;
}

const ENDED_REASONS: ReadonlySet<string> = new Set([
  "revoked",
  "refunded",
  "chargeback",
  "superseded",
]);

export function parseOnExpiry(value: string | null | undefined): OnExpiry {
  if (value === "keepVersion") return "keepVersion";
  if (
    typeof value === "string" &&
    value.startsWith("tier:") &&
    value.length > 5
  )
    return value as OnExpiry;
  return "stop";
}

export function licenseState(
  license: LicenseRow | null,
  now: number,
): LicenseState {
  if (!license) {
    return {
      state: "none",
      usable: false,
      versionCap: null,
      reason: "no_license",
    };
  }
  if (license.status !== "active") {
    const r = license.ended_reason;
    if (r && ENDED_REASONS.has(r)) {
      return {
        state: "ended",
        usable: false,
        versionCap: null,
        reason: r as LicenseStateReason,
      };
    }
    return {
      state: "suspended",
      usable: false,
      versionCap: null,
      reason: "revoked",
    };
  }
  if (license.expires_at === null || now <= license.expires_at) {
    return { state: "active", usable: true, versionCap: null, reason: null };
  }
  const on = parseOnExpiry(license.on_expiry);
  if (on === "keepVersion") {
    const fv = license.fallback_version;
    if (fv === "") {
      return {
        state: "expired",
        usable: false,
        versionCap: null,
        reason: "expired",
      };
    }
    return {
      state: "lapsed",
      usable: true,
      versionCap: fv ?? null,
      reason: null,
    };
  }
  if (on !== "stop") {
    return {
      state: "converting",
      usable: true,
      versionCap: null,
      reason: null,
    };
  }
  return {
    state: "expired",
    usable: false,
    versionCap: null,
    reason: "expired",
  };
}

/**
 * Package feeds (registry reads, the Swift login, the portal token page) refuse a lapsed licence
 * even though it is otherwise usable (plans/LX-41.md Q2).
 */
export function registryAdmits(state: LicenseState): boolean {
  return state.usable && state.state !== "lapsed";
}

/**
 * The term a tier stamps on a licence issued at `from`: the expiry date and what happens at it.
 * The pure counterpart of `tierExpiresAt`; callers switch over in LX-41.4.
 */
export function tierDuration(
  tier: Pick<TierRow, "policy_expiry_days" | "on_expiry"> | null | undefined,
  from: number,
): { expires_at: number | null; on_expiry: OnExpiry | null } {
  const expires_at = tier?.policy_expiry_days
    ? from + tier.policy_expiry_days * 86400
    : null;
  return {
    expires_at,
    on_expiry:
      expires_at !== null && tier?.on_expiry
        ? parseOnExpiry(tier.on_expiry)
        : null,
  };
}
