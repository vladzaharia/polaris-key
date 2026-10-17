/**
 * License's rows for a deleted product (P0-19; `core/products/store.ts` `deleteProduct` collects
 * them through `contributes.productDeletion`).
 *
 * R11-09 / R12-10: a deleted product keeps the SHAPE of its licences, not the people behind them.
 * `sub` and `enroll_hwid` go too: they are re-identifiers and, left in place, they keep occupying
 * `idx_licenses_sub` / `idx_licenses_enroll_hwid` so a re-created product could never re-issue to
 * the same subject or machine.
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";
import { licenseTransitionSetSql } from "../../core/licensing/lifecycleWrites.js";

export const licenseProductDeletion: ProductDeletionContributor = (
  product,
  now,
) => [
  {
    // LX-12: deleting the product revokes every licence still active (`ended_reason` `revoked`);
    // a licence that already ended keeps its status and reason.
    sql: `UPDATE licenses
             SET ${licenseTransitionSetSql("revoke")},
                 email = NULL, name = NULL, sub = NULL, groups_json = NULL,
                 enroll_hwid = NULL, account_id = NULL, modified_at = ?
           WHERE product = ?`,
    params: [now, product],
  },
  {
    sql: "UPDATE keys_index SET status = 'revoked' WHERE product = ?",
    params: [product],
  },
];
