/**
 * What the License pages share (ADMIN.md §6.5): the computed license state (LIC-1), the status
 * pill, the product's manual channels, and the "effective policy" read-out that names where
 * each value comes from (license, tier or product default; LIC-4).
 *
 * Every query here is the one fetcher per key the rest of the console uses (`queryKeyShapes`).
 */

import * as React from "react";
import { Clock } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type DeviceLimitSource,
  type LicenseSummary,
  type ProductDetail,
  type TierSummary,
} from "../../../../api.js";
import { qk } from "../../../data/queries.js";
import { fromSeconds, formatDate } from "../../../../lib/format.js";
import { compareVersions } from "../../../../lib/version.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
// LX-32: the one limits resolver. It is pure and imports nothing, so the console shares the
// Worker's implementation for the live read-out of a form that is not saved yet.
import {
  resolveLicenseTerms,
  type LicenseTerms,
} from "../../../../../../worker/src/core/licensing/terms.js";

// ── Queries ────────────────────────────────────────────────────────────────────────────────────

export function useLicenses(slug: string) {
  return useQuery({
    queryKey: qk.licenses(slug),
    queryFn: () => api.licenses(slug),
  });
}

export function useTiers(slug: string) {
  return useQuery({ queryKey: qk.tiers(slug), queryFn: () => api.tiers(slug) });
}

export function useProfiles(slug: string) {
  return useQuery({
    queryKey: qk.profiles(slug),
    queryFn: () => api.profiles(slug),
  });
}

/**
 * The product's declared channel names, from the Release truth store (a row for `stable`,
 * `beta` and every declared manual channel). `channelOptions` filters the built-ins back out. An
 * error or a 404 (Release off) means there are none: the picker still offers the canonical ones.
 */
export function useManualChannels(slug: string): string[] {
  const res = useQuery({
    queryKey: qk.releases(slug),
    queryFn: () => api.releases(slug),
  });
  return React.useMemo(
    () => (res.data?.channels ?? []).map((c) => c.channel),
    [res.data],
  );
}

// ── License state (LIC-1) ──────────────────────────────────────────────────────────────────────

export type LicenseState = "active" | "expiring" | "expired" | "disabled";

/** "Expires in N days" starts this many days out. */
export const EXPIRING_DAYS = 14;
const DAY_MS = 86_400_000;

export const LICENSE_STATE_LABELS: Record<LicenseState, string> = {
  active: "Active",
  expiring: "Expiring soon",
  expired: "Expired",
  disabled: "Disabled",
};

/**
 * The state an operator cares about, computed from `status` and `expiresAt`: the server's
 * status is only `active | disabled`, so an expired license used to read as green "active".
 */
export function licenseState(
  l: Pick<LicenseSummary, "status" | "expiresAt">,
  now: number = Date.now(),
): LicenseState {
  if (l.status === "disabled") return "disabled";
  if (l.expiresAt != null) {
    const at = fromSeconds(l.expiresAt);
    if (at <= now) return "expired";
    if (at - now <= EXPIRING_DAYS * DAY_MS) return "expiring";
  }
  return "active";
}

/** Whole days until an epoch-seconds instant (at least 1 while it is still ahead). */
export function daysUntil(
  epochSeconds: number,
  now: number = Date.now(),
): number {
  return Math.max(1, Math.ceil((fromSeconds(epochSeconds) - now) / DAY_MS));
}

export function LicenseStatus({
  license,
  now,
  size,
}: {
  license: Pick<LicenseSummary, "status" | "expiresAt">;
  now?: number;
  size?: "sm" | "md";
}): React.ReactElement {
  const state = licenseState(license, now);
  if (state === "expiring") {
    const days = daysUntil(license.expiresAt!, now);
    return (
      <StatusPill tone="warning" icon={Clock} size={size}>
        Expires in {days} {days === 1 ? "day" : "days"}
      </StatusPill>
    );
  }
  return <StatusPill domain="license" state={state} size={size} />;
}

// ── Effective policy (LIC-4) ───────────────────────────────────────────────────────────────────

export type PolicySource = "license" | "tier" | "product" | "default";

export interface PolicyLine {
  label: string;
  value: string;
  source: PolicySource;
  /** The source's own words: `tier "Pro"`, "product default". */
  from: string;
}

export interface PolicyInput {
  tier: string | null;
  /** LX-14a: the licence's own device limit (`null` inherits). */
  deviceLimit?: number | null;
  /** A `deviceLimit` entitlement under the tier (profile, store grant, override), when the
   *  Worker reported one as the inherited source. */
  entitlementDeviceLimit?: number | null;
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

const tierName = (t: TierSummary) => `tier “${t.label || t.id}”`;

// ── Device limit (LX-14a) ──────────────────────────────────────────────────────────────────────

export interface SeatLimit {
  /** The enforced limit, or `null` when there is none (a product default of 0). */
  limit: number | null;
  source: DeviceLimitSource;
  /** The source in words: "set on this license", "from Pro", "product default". */
  from: string;
}

/** A device-limit source in words, as the record, the meter and the list show it. */
export function deviceLimitFrom(
  source: DeviceLimitSource,
  tier: TierSummary | undefined,
): string {
  switch (source) {
    case "license":
      return "set on this license";
    case "tier":
      return tier ? `from ${tier.label || tier.id}` : "from the tier";
    case "entitlement":
      return "from an entitlement";
    default:
      return "product default";
  }
}

/**
 * The device limit the Worker enforces on a licence, with its source. The Worker reports both
 * (`effectiveDeviceLimit`, `deviceLimitSource`: the licence's own limit, else the tier's, else a
 * `deviceLimit` entitlement, else the product default); a response without them (an older
 * Worker) falls back to the licence's own limit, else the tier's, else the product's.
 */
export function seatLimitOf(
  license: Pick<
    LicenseSummary,
    "tier" | "deviceLimit" | "effectiveDeviceLimit" | "deviceLimitSource"
  >,
  tiers: readonly TierSummary[],
  productLimit: number | undefined,
): SeatLimit {
  const tier = license.tier
    ? tiers.find((t) => t.id === license.tier)
    : undefined;
  let limit: number | undefined;
  let source: DeviceLimitSource;
  if (
    license.effectiveDeviceLimit !== undefined &&
    license.deviceLimitSource !== undefined
  ) {
    limit = license.effectiveDeviceLimit;
    source = license.deviceLimitSource;
  } else {
    // An older Worker did not report it: resolve it here with the same resolver.
    const terms = termsOf(
      {
        tier: license.tier,
        deviceLimit: license.deviceLimit ?? null,
        entitlementDeviceLimit: null,
        maxOfflineDays: null,
        channels: [],
        minVersion: null,
        maxVersion: null,
      },
      tier,
      { defaultDeviceLimit: productLimit ?? 0, defaultMaxOfflineDays: 0 },
    );
    limit =
      productLimit === undefined && terms.deviceLimit.source === "product"
        ? undefined
        : terms.deviceLimit.value;
    source = terms.deviceLimit.source;
  }
  return {
    limit: limit && limit > 0 ? limit : null,
    source,
    from: deviceLimitFrom(source, tier),
  };
}

/** "3 · set on this license", "5 · from Pro", "No limit · product default". */
export function seatLimitText(s: SeatLimit): string {
  return `${s.limit ?? "No limit"} · ${s.from}`;
}

/** The version comparators the Worker's `tighterMin` / `tighterMax` are: the first argument (the
 *  tier's) wins a tie or a pair that does not parse. */
const minOf = (a?: string, b?: string): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  const c = compareVersions(a, b);
  return c === null || c >= 0 ? a : b;
};
const maxOf = (a?: string, b?: string): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  const c = compareVersions(a, b);
  return c === null || c <= 0 ? a : b;
};

function termsOf(
  input: PolicyInput,
  tier: TierSummary | undefined,
  product: { defaultDeviceLimit: number; defaultMaxOfflineDays: number },
): LicenseTerms {
  return resolveLicenseTerms({
    license: {
      deviceLimit: input.deviceLimit ?? null,
      maxOfflineDays: input.maxOfflineDays,
      channels: input.channels,
      minVersion: input.minVersion,
      maxVersion: input.maxVersion,
    },
    tier: tier
      ? {
          deviceLimit: tier.policyDeviceLimit ?? null,
          channels: tier.channels,
          minVersion: tier.minVersion,
          maxVersion: tier.maxVersion,
          fingerprintMode: null,
        }
      : null,
    entitlementDeviceLimit: input.entitlementDeviceLimit ?? null,
    product: {
      deviceLimit: product.defaultDeviceLimit,
      maxOfflineDays: product.defaultMaxOfflineDays,
    },
    minOf,
    maxOf,
  });
}

/**
 * What a device on these terms receives, and where each value comes from: the Worker's resolver
 * (`core/licensing/terms.ts`) rendered as read-out lines.
 */
export function effectivePolicy(
  input: PolicyInput,
  tiers: readonly TierSummary[],
  product:
    | Pick<ProductDetail, "defaultDeviceLimit" | "defaultMaxOfflineDays">
    | undefined,
): PolicyLine[] {
  const tier = input.tier ? tiers.find((t) => t.id === input.tier) : undefined;
  const terms = termsOf(input, tier, {
    defaultDeviceLimit: product?.defaultDeviceLimit ?? 0,
    defaultMaxOfflineDays: product?.defaultMaxOfflineDays ?? 0,
  });
  const lines: PolicyLine[] = [];

  const limit = terms.deviceLimit;
  lines.push({
    label: "Device limit",
    value:
      limit.source === "product"
        ? product === undefined
          ? "—"
          : limit.value > 0
            ? String(limit.value)
            : "Unlimited"
        : String(limit.value),
    source: limit.source === "entitlement" ? "license" : limit.source,
    from: deviceLimitFrom(limit.source, tier),
  });

  const offline = terms.maxOfflineDays;
  lines.push(
    offline.source === "license"
      ? {
          label: "Offline",
          value: `${offline.value} days`,
          source: "license",
          from: "this license",
        }
      : {
          label: "Offline",
          value: product === undefined ? "—" : `${offline.value} days`,
          source: "product",
          from: "product default",
        },
  );

  const ch = terms.channels;
  lines.push(
    ch.source === "none"
      ? {
          label: "Channels",
          value: "stable",
          source: "default",
          from: "default",
        }
      : {
          label: "Channels",
          value: ch.value.join(", "),
          source: ch.source === "tier" ? "tier" : "license",
          from:
            ch.source === "both"
              ? `this license and ${tierName(tier!)}`
              : ch.source === "license"
                ? "this license"
                : tierName(tier!),
        },
  );

  const { minVersion: min, maxVersion: max } = terms;
  if (min.value || max.value) {
    const fromTier = min.source === "tier" || max.source === "tier";
    const fromLicense = min.source === "license" || max.source === "license";
    lines.push({
      label: "Versions",
      value: [
        min.value ? `≥ ${min.value}` : null,
        max.value ? `≤ ${max.value}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      source: fromLicense ? "license" : "tier",
      from:
        fromLicense && fromTier
          ? `this license and ${tierName(tier!)}`
          : fromLicense
            ? "this license"
            : tierName(tier!),
    });
  } else {
    lines.push({
      label: "Versions",
      value: "Any",
      source: "default",
      from: "the product's compatibility window",
    });
  }
  return lines;
}

/** The device limit these terms resolve to, or `null` when there is none (a product default of
 *  0): what a re-tier would enforce. */
export function resolvedDeviceLimit(
  input: PolicyInput,
  tiers: readonly TierSummary[],
  product: Pick<ProductDetail, "defaultDeviceLimit"> | undefined,
): number | null {
  const tier = input.tier ? tiers.find((t) => t.id === input.tier) : undefined;
  const { value } = termsOf(input, tier, {
    defaultDeviceLimit: product?.defaultDeviceLimit ?? 0,
    defaultMaxOfflineDays: 0,
  }).deviceLimit;
  return value > 0 ? value : null;
}

/** A tier's policy in one line, for pickers and tables: "365-day term · 5 devices · stable, beta". */
export function tierSummary(t: TierSummary): string {
  return [
    t.policyExpiryDays != null ? `${t.policyExpiryDays}-day term` : "No term",
    t.policyDeviceLimit != null
      ? `${t.policyDeviceLimit} ${t.policyDeviceLimit === 1 ? "device" : "devices"}`
      : "product device limit",
    t.channels.length ? t.channels.join(", ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function EffectivePolicy({
  lines,
  title = "Effective policy",
  description,
}: {
  lines: PolicyLine[];
  title?: string;
  description?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      aria-label={title}
      className="rounded-lg border border-border bg-surface-sunken p-4"
    >
      <h3 className="text-sm font-semibold text-fg-strong">{title}</h3>
      {description ? (
        <p className="mt-0.5 text-xs text-fg-muted">{description}</p>
      ) : null}
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {lines.map((l) => (
          <div key={l.label} className="min-w-0">
            <dt className="text-xs text-fg-muted">{l.label}</dt>
            <dd className="text-fg-strong">
              {l.value}{" "}
              <span className="text-xs font-normal text-fg-muted">
                ({l.from})
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** An expiry date as text: "30 Sep 2027", or "No expiry". */
export function expiryText(expiresAt: number | null): string {
  return expiresAt == null ? "No expiry" : formatDate(fromSeconds(expiresAt));
}

/** Integer-day rule the Worker applies to `maxOfflineDays` (the bundle mint's range). */
export const MIN_OFFLINE_DAYS = 1;
export const MAX_OFFLINE_DAYS = 365;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who made a change, in words: the signed-in operator by name, an email as is, else the id. */
export function actorName(
  actor: string | undefined,
  me: { sub: string; name: string } | undefined,
): string | null {
  if (!actor) return null;
  if (me && actor === me.sub) return me.name || "you";
  return actor;
}
