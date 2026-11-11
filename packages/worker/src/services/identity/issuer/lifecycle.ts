/**
 * What an account's life does to its client grants and refresh families (I-21.15; V5 §12.13.7;
 * plans/I-34-I-21.15.md §2). Two statement builders, used by the account paths that already run in
 * one batch: erasure (`accounts/deletion.ts`: the closing batch revokes, the commit deletes), an
 * operator's disable (revokes, keeps the grants), per-product removal (`accounts/productRemoval.ts`)
 * and a merge (`accounts/merge.ts`).
 *
 * The tables are keyed by the account (and the product), so these are plain statements in the
 * caller's batch, as for `account_product_grants`: no subject store, because `SubjectStore.merge`
 * receives subjects only and a merge keeps the survivor's, which would orphan these rows. The
 * comments in migrations 0164 and 0165 ("registered by I-21.15") are superseded by this file; the
 * migrations are not edited.
 *
 * Revocation is a column that is never cleared. A family that was revoked stays revoked whatever
 * happens to the rows around it: a merge undo, an erasure replayed after a D1 restore and a
 * re-consent all leave `revoked_at` set, and the grant epoch (`refresh.ts`) refuses a family that
 * started before the grant it would ride on.
 */

import type { DbStatement } from "../../../db/types.js";

/** Revoke every refresh family of the account (one product's when `product` is given). */
export function stmtsRevokeAccountRefresh(
  accountId: string,
  now: number,
  product?: string,
): DbStatement[] {
  return [
    {
      sql: `UPDATE identity_refresh_tokens SET revoked_at = ?
             WHERE account_id = ? AND revoked_at IS NULL${product === undefined ? "" : " AND product = ?"}`,
      params:
        product === undefined ? [now, accountId] : [now, accountId, product],
    },
  ];
}

/** Delete the account's client grants and refresh rows (one product's when `product` is given). */
export function stmtsDeleteAccountIssuerRows(
  accountId: string,
  product?: string,
): DbStatement[] {
  return ["identity_refresh_tokens", "identity_client_grants"].map((table) => ({
    sql: `DELETE FROM ${table} WHERE account_id = ?${product === undefined ? "" : " AND product = ?"}`,
    params: product === undefined ? [accountId] : [accountId, product],
  }));
}
