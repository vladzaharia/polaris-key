/**
 * Distribution's rows for a deleted product (P0-19; `core/products/store.ts` `deleteProduct`
 * collects them through `contributes.productDeletion`).
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";

export const distributionProductDeletion: ProductDeletionContributor = (
  product,
  now,
) => [
  // F-hardening: a deleted product's package feeds go off (the read path also refuses a product
  // whose status is not active, so this is belt and braces for a re-created slug).
  {
    sql: `UPDATE dist_registry_owners
             SET enabled = 0, version = version + 1, updated_at = ?
           WHERE product = ? AND enabled = 1`,
    params: [now, product],
  },
];
