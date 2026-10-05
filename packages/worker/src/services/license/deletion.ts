/**
 * License's share of a licence deletion (`core/licenseDelete.ts`).
 *
 *   - blockers: a licence that holds store grants (`license_store_grants`, active OR revoked)
 *     carries a purchase history — a buyer paid for something on it — and is never deleted; the
 *     operator disables it instead.
 *     `blockerCheck` is the same fact for the batch's guard.
 *   - statements: the licence row itself, its keys (`keys_index`) and its profile stack
 *     (`license_profiles`).
 */

import type { Db, DbStatement } from "../../core/platform.js";
import {
  idChunks,
  type LicenseDeleteBlocker,
  type LicenseDeleteContributor,
  type LicenseDeleteTarget,
} from "../../core/licenseDelete.js";

async function storeGrantBlockers(
  db: Db,
  product: string,
  licenseIds: readonly string[],
): Promise<Map<string, LicenseDeleteBlocker[]>> {
  const out = new Map<string, LicenseDeleteBlocker[]>();
  for (const batch of idChunks([...new Set(licenseIds)])) {
    const marks = batch.map(() => "?").join(", ");
    const rows = await db.all<{ license_id: string; n: number }>(
      `SELECT license_id, COUNT(*) AS n FROM license_store_grants
        WHERE product = ? AND license_id IN (${marks})
        GROUP BY license_id`,
      product,
      ...batch,
    );
    for (const r of rows)
      out.set(r.license_id, [
        {
          code: "store_grants",
          message: `It holds ${r.n} store purchase ${r.n === 1 ? "grant" : "grants"}: a buyer paid for something on it.`,
        },
      ]);
  }
  return out;
}

function licenseRowStatements(target: LicenseDeleteTarget): DbStatement[] {
  const { product, licenseId } = target;
  return ["keys_index", "license_profiles"]
    .map(
      (table): DbStatement => ({
        sql: `DELETE FROM ${table} WHERE product = ? AND license_id = ?`,
        params: [product, licenseId],
      }),
    )
    .concat({
      sql: "DELETE FROM licenses WHERE product = ? AND id = ?",
      params: [product, licenseId],
    });
}

export const licenseDeleteContribution: LicenseDeleteContributor = {
  blockers: storeGrantBlockers,
  blockerCheck: ({ product, licenseId }) => ({
    sql: "SELECT 1 FROM license_store_grants WHERE product = ? AND license_id = ?",
    params: [product, licenseId],
  }),
  statements: licenseRowStatements,
};
