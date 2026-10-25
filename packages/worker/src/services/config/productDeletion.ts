/**
 * Config's rows for a deleted product (P0-19; `core/products/store.ts` `deleteProduct` collects
 * them through `contributes.productDeletion`).
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";

export const configProductDeletion: ProductDeletionContributor = (product) => [
  // U-03: every account's managed config for the product (its subjects go with Identity's rows).
  { sql: "DELETE FROM account_overrides WHERE product = ?", params: [product] },
];
