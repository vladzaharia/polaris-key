/**
 * Identity's rows for a deleted product (P0-19; `core/products/store.ts` `deleteProduct` collects
 * them through `contributes.productDeletion`): no account keeps a link to a product that no longer
 * exists, and a re-created slug starts with no history.
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";

/** Tables keyed by `product` that go whole, in the order the product's deletion removed them. */
const PRODUCT_KEYED = [
  // I-05: the product's pairwise subjects, their aliases and its "Continue to" grants.
  "account_product_subject_aliases",
  "account_product_subjects",
  "account_product_grants",
  // PX-W15: every account's acceptance of its terms (a re-created slug asks again).
  "account_terms_acceptances",
  // PS-04: every account's library entry, the storefront aggregates and the impression dedupe keys.
  "library_entries",
  "storefront_daily",
  "storefront_seen",
  // I-12 and LX-30: the relink history names accounts and subjects, and a holder move keeps the
  // licence's name and email before and after (`holder_json`); nothing is left to undo.
  "license_relinks",
] as const;

export const identityProductDeletion: ProductDeletionContributor = (product) =>
  PRODUCT_KEYED.map((table) => ({
    sql: `DELETE FROM ${table} WHERE product = ?`,
    params: [product],
  }));
