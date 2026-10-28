/**
 * Cloud Connect's erasure for a deleted product (CC-06.1; `core/products/store.ts`
 * `deleteProduct` collects the statements through `contributes.productDeletion`): every roster
 * row of the product.
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";

export const connectProductDeletion: ProductDeletionContributor = (product) => [
  { sql: "DELETE FROM connect_rings WHERE product = ?", params: [product] },
];
