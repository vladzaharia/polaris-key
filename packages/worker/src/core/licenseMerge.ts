/**
 * Licence merge — what moves when one licence is retired into another (LX-03, notes/S-19 §4.3 G6).
 *
 * Today one flow merges licences: an identity sign-in that finds the device on an anonymous
 * enrolled licence while the identity already holds a usable one (`activateFromIdentity`'s migrate
 * arm, `services/identity/oidc.ts`). The enrolled licence is disabled and its devices move to the
 * identity's licence. Before LX-03 nothing else moved, so every store purchase the anonymous
 * licence held (License's `license_store_grants`, Distribution's `dist_purchases`) stayed on a
 * disabled row, and a restore that named its purchase binding (`dist_purchase_bindings`) was
 * refused as another licence's.
 *
 * The rows belong to two services, and Identity may import neither (AGENTS.md rule 6). So Core
 * declares the step and each owner contributes its own statements — the `manifestIngest`
 * pattern (`core/registry.ts`), statements only, so they land in the SAME batch as the device
 * move and the retirement, all or nothing:
 *
 *   - `ServiceDescriptor.licenseMerge` — a service's statements re-keying its rows from the
 *     retired licence to the survivor. License re-keys `license_store_grants`; Distribution
 *     re-keys `dist_purchases` and keeps the retired licence's binding resolving as an alias
 *     (`dist_purchase_binding_aliases`), so purchases made under it reach the survivor.
 *   - {@link licenseMergeStatements} — Core's collector, run for every REGISTERED service whatever
 *     its enablement, like `manifestIngestAlways`: the rows it re-keys do nothing on their own
 *     (no request reaches a disabled service), and a purchase left on the retired licence while
 *     Distribution was off would be stranded the day it is turned back on.
 *   - {@link mergeLicenseInto} — the merge itself: the seat-checked device move (`planDeviceMove`,
 *     `repo.ts`), the services' statements and the caller's own (the retirement and its audit row)
 *     in one batch.
 *
 * This module is the one place that knows what a merge carries. S-19 is still deciding how
 * licences, grants and entitlements relate (decision 1, model OC); LX-11 replaces the binding
 * aliases with holder bindings, and nothing outside this seam should assume more than "the
 * survivor holds what the retired licence held".
 */

import type { DbStatement } from "../db/types.js";
import type { Db } from "../db/types.js";
import { SERVICE_SLUGS } from "./services.js";
import { planDeviceMove } from "../repo.js";

/** One merge, as each service's `licenseMerge` is asked about it. */
export interface LicenseMergeChange {
  product: string;
  /** The licence being retired. */
  fromLicenseId: string;
  /** The licence that survives and takes over what the retired one held. */
  toLicenseId: string;
  /** The merge's epoch seconds. */
  now: number;
}

/** What a service contributes: statements only, idempotent, re-keying rows it owns. */
export type LicenseMergeContributor = (
  change: LicenseMergeChange,
) => DbStatement[];

/** Core's collector bound to one registry (`ServiceContext.licenseMerge`). */
export type LicenseMerge = (change: LicenseMergeChange) => DbStatement[];

/** The registry shape the collector needs (a `ServiceRegistry`, kept structural to avoid a cycle). */
type MergeRegistry = ReadonlyMap<
  string,
  { licenseMerge?: LicenseMergeContributor }
>;

/**
 * Every registered service's `licenseMerge` statements, in canonical `SERVICE_SLUGS` order (so
 * the batch is the same whatever order `mount.ts` registers in). Enablement is NOT consulted: see
 * the header. A merge onto itself contributes nothing.
 */
export function licenseMergeStatements(
  registry: MergeRegistry,
  change: LicenseMergeChange,
): DbStatement[] {
  if (change.fromLicenseId === change.toLicenseId) return [];
  const out: DbStatement[] = [];
  for (const slug of SERVICE_SLUGS) {
    const contribute = registry.get(slug)?.licenseMerge;
    if (contribute) out.push(...contribute(change));
  }
  return out;
}

/** {@link licenseMergeStatements}, bound to one registry. */
export function licenseMergeFor(registry: MergeRegistry): LicenseMerge {
  return (change) => licenseMergeStatements(registry, change);
}

/** How often a merge re-plans after losing a planned seat ordinal to a concurrent activation. */
const MERGE_ATTEMPTS = 3;

/**
 * Retire `fromLicenseId` into `toLicenseId`: move its devices (seat-checked against `limit`, the
 * device limit the survivor will carry), re-key what every service holds for it, and run the
 * caller's `also` statements (the retirement, its audit row), in ONE batch.
 *
 * `device_limit` (nothing written) when the devices would not fit. A batch that throws — a
 * concurrent activation took a planned ordinal (`idx_devices_seat`) — rolled back entirely and is
 * planned again, up to {@link MERGE_ATTEMPTS} times; the last failure is rethrown.
 */
export async function mergeLicenseInto(
  db: Db,
  merge: LicenseMerge,
  change: LicenseMergeChange,
  limit: number,
  also: readonly DbStatement[],
): Promise<"merged" | "device_limit"> {
  for (let attempt = 1; ; attempt++) {
    const devices = await planDeviceMove(
      db,
      change.product,
      change.fromLicenseId,
      change.toLicenseId,
      limit,
      change.now,
    );
    if (devices === null) return "device_limit";
    try {
      await db.batch([...devices, ...merge(change), ...also]);
      return "merged";
    } catch (err) {
      if (attempt >= MERGE_ATTEMPTS) throw err;
    }
  }
}
