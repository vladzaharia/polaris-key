/**
 * Licence deletion — what goes when an operator deletes a licence outright (owner request,
 * 2026-10-05: clean up the duplicate licences the legacy in-app sign-in minted).
 *
 * Until now a licence could only be disabled. Deletion removes the licence row and every row
 * keyed by it, in one batch, and keeps the licence's audit history (the `audit` rows are never
 * touched; the deletion writes its own `license.delete` row).
 *
 * The rows belong to several owners, and a service may import no other (AGENTS.md rule 6), so
 * this follows the licence-merge seam (`core/licenseMerge.ts`): Core declares the step and each
 * owner contributes, through `ServiceDescriptor.licenseDelete`, for every REGISTERED service
 * whatever its enablement (a purchase recorded while Distribution was on still counts after it
 * is turned off):
 *
 *   - `blockers` — reads only: why this owner refuses the deletion. License refuses a licence
 *     with store grants on it, Distribution one with recorded store purchases. A refused licence
 *     can still be disabled.
 *   - `statements` — the owner's DELETEs, run in the deletion's own batch: License its licence
 *     row, keys, profile stack and store grants; Distribution the purchase binding and the
 *     aliases that resolve to the licence; Identity the portal's licence links.
 *
 * Core's own rows go through {@link coreLicenseDeleteStatements}: the devices (their facts,
 * fingerprints, delta-demand rows and any download token naming them, ahead of the devices
 * themselves because `release_download_tokens` holds a foreign key onto `devices`) and the
 * licence's registry tokens. The devices' bearer tokens live in KV and are purged by the caller
 * after the batch commits.
 *
 * Every table holding a `license_id` column is accounted for here or in a contributor;
 * `test/licenseDelete.test.ts` walks `sqlite_master` and fails when a new one appears unclaimed.
 * One is deliberately kept: a `dist_purchase_binding_aliases` row whose `from_license_id` is the
 * deleted licence belongs to the SURVIVOR of an earlier merge (its `license_id`), and keeps that
 * survivor's purchases resolving.
 */

import type { Db, DbStatement } from "../db/types.js";
import { SERVICE_SLUGS } from "./services.js";

/** One deletion, as each owner's statements are asked about it. */
export interface LicenseDeleteTarget {
  product: string;
  licenseId: string;
  /** The deletion's epoch seconds. */
  now: number;
}

/** Why a licence cannot be deleted. `code` is stable; `message` is the operator's sentence. */
export interface LicenseDeleteBlocker {
  code: string;
  message: string;
}

/** What a service contributes. Both members are optional. */
export interface LicenseDeleteContributor {
  /** Reads only: the blockers this owner raises, by licence id (absent = none). */
  blockers?(
    db: Db,
    product: string,
    licenseIds: readonly string[],
  ): Promise<Map<string, LicenseDeleteBlocker[]>>;
  /** Statements only, idempotent, touching this owner's own tables. */
  statements?(target: LicenseDeleteTarget): DbStatement[];
}

/** Core's collector bound to one registry (`ServiceContext.licenseDelete`). */
export interface LicenseDelete {
  blockers(
    db: Db,
    product: string,
    licenseIds: readonly string[],
  ): Promise<Map<string, LicenseDeleteBlocker[]>>;
  statements(target: LicenseDeleteTarget): DbStatement[];
}

type DeleteRegistry = ReadonlyMap<
  string,
  { licenseDelete?: LicenseDeleteContributor }
>;

/** D1's bound-parameter ceiling is 100; one slot is the product. */
export const LICENSE_IDS_PER_QUERY = 90;

/** `list` in slices a single `IN (…)` can bind. */
export function idChunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += LICENSE_IDS_PER_QUERY)
    out.push(list.slice(i, i + LICENSE_IDS_PER_QUERY));
  return out;
}

/**
 * Every registered service's blockers, merged per licence in canonical `SERVICE_SLUGS` order (so
 * the reasons read the same whatever order `mount.ts` registers in), and every service's
 * statements followed by Core's own.
 */
export function licenseDeleteFor(registry: DeleteRegistry): LicenseDelete {
  return {
    async blockers(db, product, licenseIds) {
      const out = new Map<string, LicenseDeleteBlocker[]>();
      if (licenseIds.length === 0) return out;
      for (const slug of SERVICE_SLUGS) {
        const ask = registry.get(slug)?.licenseDelete?.blockers;
        if (!ask) continue;
        for (const [id, list] of await ask(db, product, licenseIds)) {
          if (list.length === 0) continue;
          out.set(id, [...(out.get(id) ?? []), ...list]);
        }
      }
      return out;
    },
    statements(target) {
      const out: DbStatement[] = [];
      // Core's first: the download tokens must go before the devices they reference.
      out.push(...coreLicenseDeleteStatements(target));
      for (const slug of SERVICE_SLUGS) {
        const contribute = registry.get(slug)?.licenseDelete?.statements;
        if (contribute) out.push(...contribute(target));
      }
      return out;
    },
  };
}

/** The licence's devices, as a sub-select (the batch cannot read). */
const LICENSE_DEVICES = `SELECT device_id FROM devices WHERE product = ? AND license_id = ?`;

/** Core's rows for one licence: its devices and what hangs off them, and its registry tokens. */
export function coreLicenseDeleteStatements(
  target: LicenseDeleteTarget,
): DbStatement[] {
  const { product, licenseId } = target;
  const byDevice = (table: string): DbStatement => ({
    sql: `DELETE FROM ${table}
           WHERE product = ? AND device_id IN (${LICENSE_DEVICES})`,
    params: [product, product, licenseId],
  });
  return [
    byDevice("release_download_tokens"),
    byDevice("device_fingerprints"),
    byDevice("device_facts"),
    byDevice("delta_demand_devices"),
    {
      sql: "DELETE FROM devices WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    {
      sql: "DELETE FROM registry_tokens WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
  ];
}
