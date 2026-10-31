/**
 * I-14.13 (C10 note 6): a developer-scoped account link is keyed by the audience a product
 * declares (`SCOPE_SETTINGS`), so a setting edit or a manifest change that releases the value
 * must clear the links under it too, or whichever product claims the same id next would resolve
 * the previous developer's accounts. `productDeletion.ts` covers the deletion of a product; this
 * covers the value being changed or removed while the product lives.
 */

import type { ScopeReleaseContributor } from "../../core/contributions.js";
import {
  SYSTEM_ACTORS,
  actorColumns,
  auditStatement,
  sql,
} from "../../core/audit.js";
import { SCOPE_SETTINGS } from "./productDeletion.js";

export const identityScopeRelease: ScopeReleaseContributor = ({
  product,
  key,
  next,
  now,
  when,
}) => {
  const entry = SCOPE_SETTINGS.find(([k]) => k === key);
  if (!entry) return [];
  const prefix = entry[1];
  // The scope this product stores now, if the write really changes it and no other live product
  // declares the same value (the compare is case-insensitive, like the uniqueness rule).
  const scope = `SELECT ? || json_extract(s.value_json, '$') AS scope
         FROM product_settings s
        WHERE s.product = ? AND s.key = ?
          AND (? IS NULL OR s.value_json <> ?)${when ? ` AND (${when.sql})` : ""}
          AND NOT EXISTS (
            SELECT 1 FROM product_settings o
              JOIN products p ON p.slug = o.product
             WHERE o.key = s.key AND o.product != s.product
               AND lower(o.value_json) = lower(s.value_json)
               AND COALESCE(p.status, 'active') != 'deleted')`;
  const params = [prefix, product, key, next, next, ...(when?.params ?? [])];
  return [
    // One row, no subjects and no count; written only when a link is cleared.
    auditStatement(
      {
        product,
        at: now,
        ...actorColumns(SYSTEM_ACTORS.platform),
        action: "identity.scope_links.cleared",
        target_kind: "setting",
        target_id: key,
        summary:
          "Developer-scoped sign-in links were removed because the setting that scopes them changed; a later product that claims the same scope links again",
      },
      sql(
        `WHERE EXISTS (SELECT 1 FROM account_links WHERE tenant_scope IN (${scope}))`,
        ...params,
      ),
    ),
    {
      sql: `DELETE FROM account_links WHERE tenant_scope IN (${scope})`,
      params,
    },
  ];
};
