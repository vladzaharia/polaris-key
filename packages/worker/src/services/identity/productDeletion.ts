/**
 * Identity's rows for a deleted product (P0-19; `core/products/store.ts` `deleteProduct` collects
 * them through `contributes.productDeletion`): no account keeps a link to a product that no longer
 * exists, and a re-created slug starts with no history.
 */

import type { ProductDeletionContributor } from "../../core/contributions.js";
import {
  SYSTEM_ACTORS,
  actorColumns,
  auditStatement,
  sql,
} from "../../core/audit.js";
import type { DbParam } from "../../db/types.js";

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

/**
 * I-14.13: the audience settings whose value becomes the tenant scope of a developer-scoped
 * account link, and the scope prefix each one builds (`providers/gameCenter.ts`,
 * `providers/playGames.ts`, `passthrough/link.ts`). Each is unique across live products.
 */
const SCOPE_SETTINGS = [
  ["identity.platformSignIn.apple.teamId", "apple-team:"],
  ["identity.platformSignIn.playGames.applicationId", "pgs-app:"],
  ["identity.platformSignIn.google.serverClientId", "google-client:"],
] as const;

/**
 * The scopes the deleted product declared that no other live product declares. A link row names
 * no product, only its scope, so a scope left behind would resolve for whichever product claims
 * the same id next. The product's settings rows outlive the deletion, which is what this reads.
 */
function clearableScopes(product: string): { sql: string; params: DbParam[] } {
  const parts = SCOPE_SETTINGS.map(
    () =>
      `SELECT ? || json_extract(s.value_json, '$') AS scope
         FROM product_settings s
        WHERE s.product = ? AND s.key = ?
          AND NOT EXISTS (
            SELECT 1 FROM product_settings o
              JOIN products p ON p.slug = o.product
             WHERE o.key = s.key AND o.product != s.product
               AND lower(o.value_json) = lower(s.value_json)
               AND COALESCE(p.status, 'active') != 'deleted')`,
  );
  return {
    sql: parts.join(" UNION ALL "),
    params: SCOPE_SETTINGS.flatMap(([key, prefix]) => [prefix, product, key]),
  };
}

export const identityProductDeletion: ProductDeletionContributor = (
  product,
  now,
) => {
  const scopes = clearableScopes(product);
  const guard = sql(
    `WHERE EXISTS (SELECT 1 FROM account_links WHERE tenant_scope IN (${scopes.sql}))`,
    ...scopes.params,
  );
  return [
    ...PRODUCT_KEYED.map((table) => ({
      sql: `DELETE FROM ${table} WHERE product = ?`,
      params: [product],
    })),
    // One row, no subjects and no count; written only when a link is cleared.
    auditStatement(
      {
        product,
        at: now,
        ...actorColumns(SYSTEM_ACTORS.platform),
        action: "identity.scope_links.cleared",
        target_kind: "product",
        target_id: product,
        summary:
          "Developer-scoped sign-in links were removed with the product; a later product that claims the same scope links again",
      },
      guard,
    ),
    {
      sql: `DELETE FROM account_links WHERE tenant_scope IN (${scopes.sql})`,
      params: scopes.params,
    },
  ];
};
