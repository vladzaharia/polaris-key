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
  type LicenseSummary,
  type ProductDetail,
  type TierSummary,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";
import { fromSeconds, formatDate } from "../../../lib/format.js";
import { compareVersions } from "../../../lib/version.js";
import { StatusPill } from "../../../ui/StatusPill.js";

// ── Queries ────────────────────────────────────────────────────────────────────────────────────

export function useLicenses(slug: string) {
  return useQuery(
    { queryKey: qk.licenses(slug), queryFn: () => api.licenses(slug) },
    queryClient,
  );
}

export function useTiers(slug: string) {
  return useQuery(
    { queryKey: qk.tiers(slug), queryFn: () => api.tiers(slug) },
    queryClient,
  );
}

export function useProfiles(slug: string) {
  return useQuery(
    { queryKey: qk.profiles(slug), queryFn: () => api.profiles(slug) },
    queryClient,
  );
}

/**
 * The product's declared channel names, from the Release truth store (a row for `stable`,
 * `beta` and every declared manual channel). `channelOptions` filters the built-ins back out. An
 * error or a 404 (Release off) means there are none: the picker still offers the canonical ones.
 */
export function useManualChannels(slug: string): string[] {
  const res = useQuery(
    { queryKey: qk.releases(slug), queryFn: () => api.releases(slug) },
    queryClient,
  );
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
  expiring: `Expiring ≤${EXPIRING_DAYS} d`,
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
  maxOfflineDays: number | null;
  channels: string[];
  minVersion: string | null;
  maxVersion: string | null;
}

const tierName = (t: TierSummary) => `tier “${t.label || t.id}”`;

/** The stricter floor and the lower ceiling, as `core/entitlements.ts` merges them. */
function tighter(
  a: string | null,
  b: string | null,
  pick: "min" | "max",
): "a" | "b" | null {
  if (!a && !b) return null;
  if (!a) return "b";
  if (!b) return "a";
  const c = compareVersions(a, b);
  if (c === null) return "a";
  return pick === "min" ? (c >= 0 ? "a" : "b") : c <= 0 ? "a" : "b";
}

/**
 * What a device on these terms receives, and where each value comes from. Mirrors the Worker:
 * the device limit is the tier's, else the product's (there is no per-license limit); offline
 * days are the license's, else the product's; channels are the union of the tier's and the
 * license's (none: stable only); the version window takes the tighter bound of each.
 */
export function effectivePolicy(
  input: PolicyInput,
  tiers: readonly TierSummary[],
  product:
    | Pick<ProductDetail, "defaultDeviceLimit" | "defaultMaxOfflineDays">
    | undefined,
): PolicyLine[] {
  const tier = input.tier ? tiers.find((t) => t.id === input.tier) : undefined;
  const lines: PolicyLine[] = [];

  if (tier?.policyDeviceLimit != null) {
    lines.push({
      label: "Device limit",
      value: String(tier.policyDeviceLimit),
      source: "tier",
      from: tierName(tier),
    });
  } else {
    const limit = product?.defaultDeviceLimit;
    lines.push({
      label: "Device limit",
      value:
        limit === undefined ? "—" : limit > 0 ? String(limit) : "Unlimited",
      source: "product",
      from: "product default",
    });
  }

  if (input.maxOfflineDays != null) {
    lines.push({
      label: "Offline",
      value: `${input.maxOfflineDays} d`,
      source: "license",
      from: "this license",
    });
  } else {
    const d = product?.defaultMaxOfflineDays;
    lines.push({
      label: "Offline",
      value: d === undefined ? "—" : `${d} d`,
      source: "product",
      from: "product default",
    });
  }

  const tierChannels = tier?.channels ?? [];
  const union = [...new Set([...tierChannels, ...input.channels])];
  lines.push(
    union.length === 0
      ? {
          label: "Channels",
          value: "stable",
          source: "default",
          from: "default",
        }
      : {
          label: "Channels",
          value: union.join(", "),
          source: input.channels.length ? "license" : "tier",
          from:
            input.channels.length && tierChannels.length
              ? `this license and ${tierName(tier!)}`
              : input.channels.length
                ? "this license"
                : tierName(tier!),
        },
  );

  const minPick = tighter(input.minVersion, tier?.minVersion ?? null, "min");
  const maxPick = tighter(input.maxVersion, tier?.maxVersion ?? null, "max");
  if (minPick || maxPick) {
    const min =
      minPick === "a"
        ? input.minVersion
        : minPick === "b"
          ? tier!.minVersion
          : null;
    const max =
      maxPick === "a"
        ? input.maxVersion
        : maxPick === "b"
          ? tier!.maxVersion
          : null;
    const fromTier = minPick === "b" || maxPick === "b";
    const fromLicense = minPick === "a" || maxPick === "a";
    lines.push({
      label: "Versions",
      value: [min ? `≥ ${min}` : null, max ? `≤ ${max}` : null]
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
      <h3 className="text-sm font-bold text-fg-strong">{title}</h3>
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
