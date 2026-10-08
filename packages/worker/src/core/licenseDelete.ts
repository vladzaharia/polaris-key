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
 *   - `blockerCheck` — the same refusal as a sub-select. Every statement of the batch is guarded
 *     with `NOT EXISTS` of each, so a purchase recorded between the read and the batch leaves the
 *     licence untouched rather than deleting one a buyer just paid on (the caller sees the licence
 *     still there and answers the refusal).
 *   - `statements` — the owner's DELETEs, run in the deletion's own batch: License its licence
 *     row, keys and profile stack; Distribution the purchase binding and the aliases that resolve
 *     to the licence; Identity the portal's licence links. (Store grants and purchases are never
 *     deleted: their presence is what refuses the deletion.)
 *
 * Core's own rows go through {@link coreLicenseDeleteStatements}: the devices (their facts,
 * fingerprints, delta-demand rows and any download token naming them, ahead of the devices
 * themselves because `release_download_tokens` holds a foreign key onto `devices`), the
 * licence's registry tokens, its refused-activation log (`license_refusals`), its auto-attach
 * blocks (`license_auto_attach_blocks`, LX-26), its key-entry counter (`license_key_entries`,
 * PX-W9) and its grants with their keys, holder version and entitlement events (LX-08). The devices' bearer tokens live in KV and are purged by the caller
 * after the batch commits.
 *
 * Every table holding a `license_id` column is accounted for here, in a contributor, or by a
 * blocker;
 * `test/licenseDelete.test.ts` walks `sqlite_master` and fails when a new one appears unclaimed.
 * One is deliberately kept: a `dist_purchase_binding_aliases` row whose `from_license_id` is the
 * deleted licence belongs to the SURVIVOR of an earlier merge (its `license_id`), and keeps that
 * survivor's purchases resolving.
 */

import type { Db, DbParam, DbStatement } from "../db/types.js";
import { SERVICE_SLUGS } from "./services.js";
import { licenseGrantDeleteStatements } from "./grants.js";

/** One deletion, as each owner's statements are asked about it. */
export interface LicenseDeleteTarget {
  product: string;
  licenseId: string;
  /** The deletion's epoch seconds. */
  now: number;
}

/**
 * The closed set of reasons a licence deletion is refused. These are not error codes: they ride
 * inside a 409 `license_not_deletable` body's `reasons[]` (admin console only), so they are named
 * through this table rather than as `code: "<literal>"` fields, which the error-code registry's
 * Worker scan (tools/gen-sdk-constants.ts) reads as wire error codes.
 */
export const LicenseDeleteReason = {
  /** The route has no licence-deletion wiring. */
  Unavailable: "unavailable",
  /** The licence is active and was issued by the developer; disable it first. */
  IssuedActive: "issued_active",
  /** A disabled auto-enrolled licence still bound to its machine blocks re-enrollment. */
  EnrollGuard: "enroll_guard",
  /** The licence changed between the verdict and the batch. */
  Changed: "changed",
  /** License: it holds store purchase grants. */
  StoreGrants: "store_grants",
  /** Distribution: store purchases are recorded against it. */
  StorePurchases: "store_purchases",
} as const;
export type LicenseDeleteReasonCode =
  (typeof LicenseDeleteReason)[keyof typeof LicenseDeleteReason];

/** Why a licence cannot be deleted. `code` is stable; `message` is the operator's sentence. */
export interface LicenseDeleteBlocker {
  code: LicenseDeleteReasonCode;
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
  /**
   * The same refusal as a sub-select for the batch: `SELECT 1 FROM … WHERE …`, a row meaning
   * "blocked". Core guards every statement of the deletion with `NOT EXISTS (…)` of each owner's
   * check, so a purchase recorded between the read and the batch turns the whole batch into a
   * no-op instead of deleting a licence a buyer just paid on.
   */
  blockerCheck?(target: LicenseDeleteTarget): DbStatement;
  /**
   * Statements only, idempotent, touching this owner's own tables. Each must be a `DELETE … WHERE
   * …` ending in its WHERE clause: Core appends the guard to it.
   */
  statements?(target: LicenseDeleteTarget): DbStatement[];
}

/** A boolean SQL expression and its parameters. */
export interface SqlCondition {
  sql: string;
  params: DbParam[];
}

/** Core's collector bound to one registry (`ServiceContext.licenseDelete`). */
export interface LicenseDelete {
  blockers(
    db: Db,
    product: string,
    licenseIds: readonly string[],
  ): Promise<Map<string, LicenseDeleteBlocker[]>>;
  /** True while no owner's blocker exists for the licence (`blockerCheck`). */
  guard(target: LicenseDeleteTarget): SqlCondition;
  /** Every owner's statements and Core's, each guarded by {@link LicenseDelete.guard}. */
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
    guard(target) {
      return guardOf(registry, target);
    },
    statements(target) {
      const out: DbStatement[] = [];
      // Core's first: the download tokens must go before the devices they reference.
      out.push(...coreLicenseDeleteStatements(target));
      for (const slug of SERVICE_SLUGS) {
        const contribute = registry.get(slug)?.licenseDelete?.statements;
        if (contribute) out.push(...contribute(target));
      }
      const guard = guardOf(registry, target);
      return out.map((s) => ({
        sql: `${s.sql} AND ${guard.sql}`,
        params: [...s.params, ...guard.params],
      }));
    },
  };
}

function guardOf(
  registry: DeleteRegistry,
  target: LicenseDeleteTarget,
): SqlCondition {
  const parts: string[] = [];
  const params: DbParam[] = [];
  for (const slug of SERVICE_SLUGS) {
    const check = registry.get(slug)?.licenseDelete?.blockerCheck;
    if (!check) continue;
    const c = check(target);
    parts.push(`NOT EXISTS (${c.sql})`);
    params.push(...c.params);
  }
  return { sql: parts.length ? `(${parts.join(" AND ")})` : "1", params };
}

/** The licence's devices, as a sub-select (the batch cannot read). */
const LICENSE_DEVICES = `SELECT device_id FROM devices WHERE product = ? AND license_id = ?`;

/** Core's rows for one licence: its devices and what hangs off them, its registry tokens, its
 *  refused activations, its auto-attach blocks and its key entries. */
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
    // Main's 0074: the refused activations the licence's Status card shows.
    {
      sql: "DELETE FROM license_refusals WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    // LX-26: the accounts this licence must not rejoin automatically; nothing is left to block.
    {
      sql: "DELETE FROM license_auto_attach_blocks WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    // PX-W9: the licence's key-entry counter (WIRE-CONTRACT-V4 §12.2).
    {
      sql: "DELETE FROM license_key_entries WHERE product = ? AND license_id = ?",
      params: [product, licenseId],
    },
    // LX-08: the grants the licence holds (its `oidc` grant: a store grant refuses the deletion),
    // their keys, its holder version and its entitlement events (`core/grants.ts`).
    ...licenseGrantDeleteStatements({ product, licenseId }),
  ];
}
