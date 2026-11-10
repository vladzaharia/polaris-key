/**
 * LX-34.7: the entitlement bucket planner (pure; no D1).
 *
 * LX-34 moves a product's entitlements out of the managed-payload profiles. The entitlements bucket
 * of a TIER's profile moves to `tiers.entitlements_json`; the buckets of a LICENCE's profiles move
 * into the licence's own overrides (`licenses.overrides_json.entitlements`), under the entries the
 * licence already holds. The job that does it (`license.entitlement-buckets`, LX-34.8) must change
 * no document. This file decides, per tier and per licence, what it writes, and proves each licence
 * is safe by running BOTH chains over the rows as they would stand and comparing the merged
 * entitlements, values and key order:
 *
 *   old   catalog, tier profile, licence profiles, store grants, overrides, OIDC grant
 *   new   catalog, tier bucket, store grants, overrides (profile buckets underneath), OIDC grant
 *
 * The two differ only where something sits between a licence profile and the overrides: a key a
 * store or OIDC grant also sets (D34-7), or an order a grant's keys change. Such a licence is
 * reported in `docDiffs` and left alone: the owner decides each case. A tier whose bucket already
 * holds something else (a manifest-declared bucket, LX-34.5) is reported the same way.
 *
 * Entries are copied verbatim (state, value, `updatedAt`); the layers are read and merged by the
 * resolver's own functions (`mergePayloads`, `storeGrantLayerOf`, `oidcGrantLayerOf`), never copied.
 * Planning rows the job already wrote returns no writes.
 */
import type { ManagedEntry } from "@polaris-key/protocol";
import type { LicenseRow, TierRow } from "../repo.js";
import { oidcGrantLayerOf, type GrantEntryRow } from "./grants.js";
import { isImplicitTier } from "./implicitTier.js";
import { sameValue } from "../settings/resolve.js";
import { mergePayloads } from "./merge.js";
import { storeGrantLayerOf, type ActiveStoreGrant } from "./storeGrants.js";

export type BucketTier = Pick<TierRow, "id" | "profile_id"> &
  Partial<Pick<TierRow, "implicit" | "entitlements_json">>;

export interface BucketLicence {
  row: Pick<LicenseRow, "id" | "tier_id" | "overrides_json">;
  /** The licence's profile ids, in merge order. */
  profileIds: readonly string[];
  /** The licence's active store grants, as `storeGrantLayerOf` takes them. */
  storeGrants: readonly ActiveStoreGrant[];
  /** The licence's contributing `oidc` grant entries, as `oidcGrantLayerOf` takes them. */
  oidcGrants: readonly GrantEntryRow[];
}

export interface BucketPlanInput {
  /** The catalog's default layer (`catalogDefaultPayload`). */
  catalogDefault: string | null;
  tiers: readonly BucketTier[];
  /** Profile id -> `payload_json`. */
  profiles: ReadonlyMap<string, string | null>;
  /** Tier id -> the bucket JSON the job last wrote there (its ledger's `after`): a tier still
   *  holding it may be rewritten. */
  ownedTierBuckets?: ReadonlyMap<string, string>;
  licences: readonly BucketLicence[];
}

export type BucketDiffReason =
  /** A key a licence profile sets is also set by a store or OIDC grant (D34-7). */
  | "grant-key"
  /** The same entries, but a grant's keys change their order. */
  | "key-order"
  /** The merged entitlements differ for another reason (a tier bucket that is not the profile's). */
  | "value"
  /** The tier's bucket already holds something other than its profile's. */
  | "tier-bucket-differs"
  /** The licence's overrides are not a JSON object; they are never rewritten. */
  | "overrides-unreadable";

export interface BucketDocDiff {
  subjectKind: "license" | "tier";
  subjectId: string;
  reasons: BucketDiffReason[];
  /** The keys involved (capped by the caller). */
  keys: string[];
}

export interface TierBucketWrite {
  tierId: string;
  /** `tiers.entitlements_json` now. */
  before: string | null;
  after: string;
}

export interface LicenceBucketWrite {
  licenseId: string;
  /** `licenses.overrides_json` now. */
  before: string | null;
  after: string;
  /** The keys the licence profiles contribute. */
  keys: string[];
}

export interface BucketPlan {
  tierWrites: TierBucketWrite[];
  licenceWrites: LicenceBucketWrite[];
  docDiffs: BucketDocDiff[];
}

type Entries = Record<string, ManagedEntry>;

/** A payload JSON's entitlements, cleaned the way the merge cleans them. */
const entitlementsOf = (payloadJson: string | null | undefined): Entries =>
  mergePayloads(payloadJson).entitlements;

const wrap = (entries: Entries): string =>
  JSON.stringify({ entitlements: entries });

/** A stored bucket (a bare entitlements map) as a cleaned map; unreadable = empty. */
function parseBucket(json: string | null | undefined): Entries {
  if (!json) return {};
  try {
    return entitlementsOf(wrap(JSON.parse(json) as Entries));
  } catch {
    return {};
  }
}

const sameContent = (a: Entries, b: Entries): boolean => sameValue(a, b);
const sameOrder = (a: Entries, b: Entries): boolean =>
  Object.keys(a).join("\u0000") === Object.keys(b).join("\u0000");

/** The overrides as an object, or `null` when they are not one (absent = `{}`). */
function overridesObject(json: string | null): Record<string, unknown> | null {
  if (!json) return {};
  try {
    const p: unknown = JSON.parse(json);
    return p !== null && typeof p === "object" && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const keysOf = (layer: string | null): string[] =>
  Object.keys(entitlementsOf(layer));

export function planEntitlementBuckets(input: BucketPlanInput): BucketPlan {
  const plan: BucketPlan = { tierWrites: [], licenceWrites: [], docDiffs: [] };
  const tierById = new Map(input.tiers.map((t) => [t.id, t]));

  // Tiers: the profile's bucket becomes the tier's. `tierLayer` is what the new chain reads.
  const tierLayer = new Map<string, string | null>();
  for (const t of input.tiers) {
    if (isImplicitTier(t) || !t.profile_id) continue;
    const bucket = entitlementsOf(input.profiles.get(t.profile_id));
    if (Object.keys(bucket).length === 0) continue;
    const existing = t.entitlements_json ?? null;
    if (existing === null || sameContent(parseBucket(existing), bucket)) {
      tierLayer.set(t.id, wrap(bucket));
      if (existing === null)
        plan.tierWrites.push({
          tierId: t.id,
          before: null,
          after: JSON.stringify(bucket),
        });
    } else if (input.ownedTierBuckets?.get(t.id) === existing) {
      tierLayer.set(t.id, wrap(bucket));
      plan.tierWrites.push({
        tierId: t.id,
        before: existing,
        after: JSON.stringify(bucket),
      });
    } else {
      tierLayer.set(t.id, wrap(parseBucket(existing)));
      plan.docDiffs.push({
        subjectKind: "tier",
        subjectId: t.id,
        reasons: ["tier-bucket-differs"],
        keys: Object.keys(bucket),
      });
    }
  }

  for (const l of input.licences) {
    const { row } = l;
    const tier = row.tier_id ? (tierById.get(row.tier_id) ?? null) : null;
    const storeLayer = storeGrantLayerOf(l.storeGrants);
    const profileLayers = l.profileIds.map(
      (id) => input.profiles.get(id) ?? null,
    );
    const tierProfileLayer =
      tier && tier.profile_id && !isImplicitTier(tier)
        ? (input.profiles.get(tier.profile_id) ?? null)
        : null;

    const oldEntitlements = mergePayloads(
      input.catalogDefault,
      tierProfileLayer,
      ...profileLayers,
      storeLayer,
      row.overrides_json,
      oidcGrantLayerOf(l.oidcGrants, row.overrides_json),
    ).entitlements;

    // The licence profiles' buckets go under the overrides' own entries.
    const moved = profileLayers.map((p) => wrap(entitlementsOf(p)));
    const movedKeys = [...new Set(profileLayers.flatMap(keysOf))];
    let overrides = row.overrides_json;
    let write: LicenceBucketWrite | null = null;
    let unreadable = false;
    if (movedKeys.length > 0) {
      const obj = overridesObject(row.overrides_json);
      if (obj === null) unreadable = true;
      else {
        const merged = mergePayloads(...moved, row.overrides_json).entitlements;
        if (
          !sameContent(merged, entitlementsOf(row.overrides_json)) ||
          !sameOrder(merged, entitlementsOf(row.overrides_json))
        ) {
          overrides = JSON.stringify({ ...obj, entitlements: merged });
          write = {
            licenseId: row.id,
            before: row.overrides_json,
            after: overrides,
            keys: movedKeys,
          };
        }
      }
    }

    const reasons: BucketDiffReason[] = [];
    let keys: string[] = [];
    if (unreadable) reasons.push("overrides-unreadable");
    else {
      const newEntitlements = mergePayloads(
        input.catalogDefault,
        row.tier_id ? (tierLayer.get(row.tier_id) ?? null) : null,
        storeLayer,
        overrides,
        oidcGrantLayerOf(l.oidcGrants, overrides),
      ).entitlements;
      if (
        !sameContent(oldEntitlements, newEntitlements) ||
        !sameOrder(oldEntitlements, newEntitlements)
      ) {
        const grantKeys = new Set([
          ...l.storeGrants.map((g) => g.flag),
          ...l.oidcGrants.map((g) => g.key),
        ]);
        const shared = movedKeys.filter((k) => grantKeys.has(k));
        if (shared.length > 0) {
          reasons.push("grant-key");
          keys = shared;
        } else if (sameContent(oldEntitlements, newEntitlements)) {
          reasons.push("key-order");
          keys = movedKeys;
        } else {
          reasons.push("value");
          keys = Object.keys(newEntitlements).filter(
            (k) => !sameValue(newEntitlements[k], oldEntitlements[k]),
          );
        }
      }
    }
    if (reasons.length > 0)
      plan.docDiffs.push({
        subjectKind: "license",
        subjectId: row.id,
        reasons,
        keys,
      });
    else if (write) plan.licenceWrites.push(write);
  }
  return plan;
}
