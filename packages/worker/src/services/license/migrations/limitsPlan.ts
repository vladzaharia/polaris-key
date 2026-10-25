/**
 * LX-33.4: the materialisation planner (pure; no D1).
 *
 * LX-33 moves every licence onto "licence, else tier, else platform" (`chain: "override"`). The
 * job that gets existing data there (LX-33.5) must change no document and no enforcement. This
 * file decides, per product, what that job writes: it seeds the implicit Default tier, assigns
 * tierless licences to it, and copies onto a licence exactly the values the old chain would have
 * derived from elsewhere (the tier's channels and bounds, an entitlement or product limit, the
 * product's offline days), so the new chain returns what the old one did. The rules are plan
 * LX-33 §2; the comparators and both chains are the resolver's, never copied here.
 *
 * The report also names what cannot be preserved byte for byte (`docDiffs`, the D4 cases), tier
 * ids that point nowhere (`dangling`) and tiers that store `dev` without `beta` (`devOnlyTiers`).
 */
import {
  chainTier,
  isImplicitTier,
} from "../../../core/licensing/implicitTier.js";
import {
  licenseOwnDeviceLimit,
  licenseTermsOf,
  stampedEntitlements,
  tighterMax,
  tighterMin,
} from "../../../core/licensing/entitlements.js";
import { resolveLicenseTerms } from "../../../core/licensing/terms.js";
import {
  DEFAULT_DEVICE_LIMIT,
  DEFAULT_MAX_OFFLINE_DAYS,
} from "../../../core/settings/platform.js";
import type { LicenseRow, TierRow } from "../../../core/repo.js";

export type PlanTier = Pick<
  TierRow,
  | "id"
  | "label"
  | "policy_device_limit"
  | "channels_json"
  | "min_version"
  | "max_version"
> &
  Partial<
    Pick<
      TierRow,
      | "implicit"
      | "profile_id"
      | "policy_expiry_days"
      | "policy_fingerprint"
      | "policy_offline_grace_days"
      | "rank"
    >
  >;

export type PlanLicense = Pick<
  LicenseRow,
  | "id"
  | "tier_id"
  | "max_offline_days"
  | "channels_json"
  | "min_version"
  | "max_version"
> &
  Partial<Pick<LicenseRow, "device_limit">>;

export interface PlanProduct {
  /** `products.default_device_limit`. */
  defaultDeviceLimit: number;
  /** `products.default_max_offline_days`. */
  defaultMaxOfflineDays: number;
  /** The product's compat range; applied after the overrides on both chains. */
  compat?: { min?: string | null; max?: string | null };
}

/** The licence columns the job may write (`modified_at`, `modified_by`, `expires_at` never). */
export interface LimitColumns {
  tier_id: string | null;
  channels_json: string | null;
  min_version: string | null;
  max_version: string | null;
  device_limit: number | null;
  max_offline_days: number | null;
}

export interface LimitsSeed {
  /** `create`: no implicit tier yet. `update`: it exists with other values. */
  action: "create" | "update";
  id: string;
  label: "Default";
  /** Every apply re-seeds these from `products.default_*`; the rest are fixed. */
  row: {
    policy_device_limit: number;
    policy_offline_grace_days: number;
    channels_json: null;
    min_version: null;
    max_version: null;
    profile_id: null;
    policy_fingerprint: null;
    policy_expiry_days: null;
    rank: 0;
    implicit: 1;
    source: "console";
  };
}

export interface LimitsWrite {
  licenseId: string;
  /** The changed columns, before and after (the ledger's rows). */
  before: Partial<LimitColumns>;
  after: Partial<LimitColumns>;
}

export type DocDiffReason =
  /** D4 (a): the limit came from a `deviceLimit` entitlement. */
  | "device-entitlement"
  /** D4 (b): a non-implicit tier leaves the limit unset on a product whose default is not 5. */
  | "device-tier-unset"
  /** D4 (c): the tier id points at no tier. */
  | "dangling-tier";

export interface DocDiff {
  licenseId: string;
  /** The projection fields that differ (`stamp:deviceLimit`, `deviceLimit`, `offlineDays`, ...). */
  fields: string[];
  reasons: DocDiffReason[];
}

export interface LimitsPlan {
  /** Absent when the implicit tier already holds the seeded values. */
  seed?: LimitsSeed;
  writes: LimitsWrite[];
  /** Licences whose `tier_id` names no tier: reported, never reassigned. */
  dangling: Array<{ licenseId: string; tierId: string }>;
  /** Non-implicit tiers storing `dev` without `beta`. */
  devOnlyTiers: string[];
  docDiffs: DocDiff[];
}

export interface PlanInput {
  product: PlanProduct;
  tiers: readonly PlanTier[];
  licences: readonly PlanLicense[];
  /** Each licence's merged `deviceLimit` entitlement (profile, store grant, override), if any. */
  mergedDeviceLimit: ReadonlyMap<string, number | null | undefined>;
}

function parseChannels(json: string | null | undefined): string[] {
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

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** The implicit tier's row as the seed leaves it. */
function seedRow(product: PlanProduct): LimitsSeed["row"] {
  return {
    policy_device_limit: product.defaultDeviceLimit,
    policy_offline_grace_days: product.defaultMaxOfflineDays,
    channels_json: null,
    min_version: null,
    max_version: null,
    profile_id: null,
    policy_fingerprint: null,
    policy_expiry_days: null,
    rank: 0,
    implicit: 1,
    source: "console",
  };
}

function seedMatches(t: PlanTier, row: LimitsSeed["row"]): boolean {
  return (
    t.policy_device_limit === row.policy_device_limit &&
    (t.policy_offline_grace_days ?? null) === row.policy_offline_grace_days &&
    t.channels_json === null &&
    t.min_version === null &&
    t.max_version === null &&
    (t.profile_id ?? null) === null &&
    (t.policy_fingerprint ?? null) === null &&
    (t.policy_expiry_days ?? null) === null &&
    (t.rank ?? 0) === 0
  );
}

/** The first free of `default`, `default-2`, ... */
function freeDefaultId(tiers: readonly PlanTier[]): string {
  const taken = new Set(tiers.map((t) => t.id));
  if (!taken.has("default")) return "default";
  for (let n = 2; ; n++) if (!taken.has(`default-${n}`)) return `default-${n}`;
}

export interface Projection {
  stamps: Record<string, unknown>;
  offlineDays: number;
  deviceLimit: number;
  channels: string[];
  window: { min: string | null; max: string | null };
}

export type ChainLicense = PlanLicense & { device_limit?: number | null };

/** The old chain's documents and enforcement for a licence on its tier (exported for the tests). */
export function projectOld(
  l: ChainLicense,
  tier: PlanTier | null,
  product: PlanProduct,
  ent: number | null,
): Projection {
  const terms = licenseTermsOf(
    { ...l, device_limit: l.device_limit ?? null },
    tier as TierRow | null,
    {
      defaultDeviceLimit: product.defaultDeviceLimit,
      defaultMaxOfflineDays: product.defaultMaxOfflineDays,
    },
    ent,
  );
  const stamps = stampedEntitlements(
    l,
    tier ? { label: tier.label, implicit: tier.implicit } : null,
    terms,
    0,
  );
  return {
    stamps: Object.fromEntries(
      Object.entries(stamps).map(([k, e]) => [k, e.value]),
    ),
    offlineDays: terms.maxOfflineDays.value,
    deviceLimit: terms.deviceLimit.value,
    channels: [...terms.channels.value].sort(),
    window: {
      min:
        tighterMin(
          product.compat?.min ?? undefined,
          terms.minVersion.value ?? undefined,
        ) ?? null,
      max:
        tighterMax(
          product.compat?.max ?? undefined,
          terms.maxVersion.value ?? undefined,
        ) ?? null,
    },
  };
}

/** The new chain's, the same projection. */
export function projectNew(
  l: ChainLicense,
  tier: PlanTier | null,
  product: PlanProduct,
): Projection {
  const terms = newTerms(l, tier, product);
  const stamps = stampedEntitlements(
    l,
    tier ? { label: tier.label, implicit: tier.implicit } : null,
    terms,
    0,
  );
  return {
    stamps: Object.fromEntries(
      Object.entries(stamps).map(([k, e]) => [k, e.value]),
    ),
    offlineDays: terms.maxOfflineDays.value,
    deviceLimit: terms.deviceLimit.value,
    channels: [...terms.channels.value].sort(),
    window: terms.window,
  };
}

function newTerms(l: ChainLicense, tier: PlanTier | null, p: PlanProduct) {
  return resolveLicenseTerms({
    chain: "override",
    license: {
      deviceLimit: licenseOwnDeviceLimit({ device_limit: l.device_limit }),
      maxOfflineDays: l.max_offline_days,
      channels: parseChannels(l.channels_json),
      minVersion: l.min_version,
      maxVersion: l.max_version,
    },
    tier: tier
      ? {
          deviceLimit:
            typeof tier.policy_device_limit === "number"
              ? tier.policy_device_limit
              : null,
          channels: parseChannels(tier.channels_json),
          minVersion: tier.min_version,
          maxVersion: tier.max_version,
          fingerprintMode: tier.policy_fingerprint ?? null,
          maxOfflineDays: tier.policy_offline_grace_days ?? null,
        }
      : null,
    product: {
      deviceLimit: p.defaultDeviceLimit,
      maxOfflineDays: p.defaultMaxOfflineDays,
    },
    platform: {
      deviceLimit: DEFAULT_DEVICE_LIMIT,
      maxOfflineDays: DEFAULT_MAX_OFFLINE_DAYS,
    },
    extraSeats: 0,
    compat: p.compat,
    minOf: tighterMin,
    maxOf: tighterMax,
  });
}

const DIFF_KEYS = ["offlineDays", "deviceLimit", "channels", "window"] as const;

function diffProjections(a: Projection, b: Projection): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a.stamps), ...Object.keys(b.stamps)]);
  for (const k of [...keys].sort())
    if (JSON.stringify(a.stamps[k]) !== JSON.stringify(b.stamps[k]))
      out.push(`stamp:${k}`);
  for (const k of DIFF_KEYS)
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

export function planLimitsMaterialisation(input: PlanInput): LimitsPlan {
  const { product, licences, mergedDeviceLimit } = input;

  // Seeding: one implicit Default tier, values from the product's defaults.
  const existing = input.tiers.find((t) => isImplicitTier(t)) ?? null;
  const row = seedRow(product);
  const seedId = existing ? existing.id : freeDefaultId(input.tiers);
  let seed: LimitsSeed | undefined;
  if (!existing) seed = { action: "create", id: seedId, label: "Default", row };
  else if (!seedMatches(existing, row))
    seed = { action: "update", id: seedId, label: "Default", row };

  // The tiers as they stand after seeding.
  const seeded: PlanTier = {
    id: seedId,
    label: existing ? existing.label : "Default",
    ...row,
  };
  const after = new Map<string, PlanTier>();
  for (const t of input.tiers) after.set(t.id, t);
  after.set(seedId, seeded);

  const writes: LimitsWrite[] = [];
  const dangling: LimitsPlan["dangling"] = [];
  const docDiffs: DocDiff[] = [];

  for (const l of licences) {
    const own = { ...l, device_limit: l.device_limit ?? null };
    const tierBefore = l.tier_id
      ? (input.tiers.find((t) => t.id === l.tier_id) ?? null)
      : null;
    const tierAfter = l.tier_id ? (after.get(l.tier_id) ?? null) : seeded;
    const isDangling = !!l.tier_id && !tierAfter;
    if (isDangling && l.tier_id)
      dangling.push({ licenseId: l.id, tierId: l.tier_id });
    const ent = mergedDeviceLimit.get(l.id) ?? null;

    const oldTerms = licenseTermsOf(
      own,
      tierBefore as TierRow | null,
      {
        defaultDeviceLimit: product.defaultDeviceLimit,
        defaultMaxOfflineDays: product.defaultMaxOfflineDays,
      },
      ent,
    );
    const newTerm = newTerms(own, tierAfter, product);

    const next: Partial<LimitColumns> = {};
    // Tier: tierless becomes the implicit tier; a dangling id stays.
    if (!l.tier_id) next.tier_id = seedId;

    // The old chain only reads a non-implicit tier.
    const t = chainTier(tierBefore);
    // Channels: both set -> today's union (tier first), verbatim.
    const tierCh = parseChannels(t?.channels_json);
    const licCh = parseChannels(l.channels_json);
    if (tierCh.length && licCh.length) {
      const union = [...new Set([...tierCh, ...licCh])];
      if (!sameList(union, licCh)) next.channels_json = JSON.stringify(union);
    }
    // Versions: both set the same bound -> the tighter of the two, as the gate resolves it.
    if (t?.min_version && l.min_version) {
      const m = tighterMin(t.min_version, l.min_version);
      if (m !== undefined && m !== l.min_version) next.min_version = m;
    }
    if (t?.max_version && l.max_version) {
      const m = tighterMax(t.max_version, l.max_version);
      if (m !== undefined && m !== l.max_version) next.max_version = m;
    }
    // Device limit: today's value wins where the new chain would give another.
    if (
      licenseOwnDeviceLimit(own) === null &&
      newTerm.deviceLimit.value !== oldTerms.deviceLimit.value
    )
      next.device_limit = oldTerms.deviceLimit.value;
    // Offline days: the product default where the new chain would give another.
    if (
      l.max_offline_days === null &&
      newTerm.maxOfflineDays.value !== product.defaultMaxOfflineDays
    )
      next.max_offline_days = product.defaultMaxOfflineDays;

    const keys = Object.keys(next) as Array<keyof LimitColumns>;
    if (keys.length) {
      const before: Partial<LimitColumns> = {};
      for (const k of keys)
        (before as Record<string, unknown>)[k] = own[k] ?? null;
      writes.push({ licenseId: l.id, before, after: next });
    }

    // Documents: the old chain on the old rows against the new chain on the new rows.
    const post: ChainLicense = {
      ...own,
      ...next,
      tier_id: next.tier_id ?? own.tier_id,
    };
    const fields = diffProjections(
      projectOld(own, tierBefore, product, ent),
      projectNew(post, tierAfter, product),
    );
    if (fields.length) {
      const reasons: DocDiffReason[] = [];
      if (fields.some((f) => f.endsWith("deviceLimit"))) {
        if (ent !== null && ent !== product.defaultDeviceLimit)
          reasons.push("device-entitlement");
        else if (
          tierBefore &&
          !isImplicitTier(tierBefore) &&
          tierBefore.policy_device_limit == null
        )
          reasons.push("device-tier-unset");
        else if (ent !== null) reasons.push("device-entitlement");
      }
      if (isDangling) reasons.push("dangling-tier");
      docDiffs.push({ licenseId: l.id, fields, reasons });
    }
  }

  const devOnlyTiers = input.tiers
    .filter((t) => !isImplicitTier(t))
    .filter((t) => {
      const c = parseChannels(t.channels_json);
      return c.includes("dev") && !c.includes("beta");
    })
    .map((t) => t.id);

  return {
    ...(seed ? { seed } : {}),
    writes,
    dangling,
    devOnlyTiers,
    docDiffs,
  };
}
