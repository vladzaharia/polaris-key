/**
 * Column adapters for the settings stored in Identity's tables (ST-04, notes/S-18 §4.3). Core's
 * resolver decodes them and Core's `writeSetting()` is the only caller of `set`; the SQL lives
 * here, with the table's owner (`portal_product_settings` is Identity's, `TABLE_OWNERS`), never in
 * Core. Contributed through Identity's slice (`settings.ts`).
 *
 *   identity.keyEntry.claimByKey  `portal_product_settings.claim_by_key` (I-09), until ST-14 folds
 *                                 the table into `product_settings` rows. No row reads as unset,
 *                                 which the resolver answers with the default, off.
 *
 * Every statement ANDs the write's guard into its `WHERE` (`ColumnWriteArgs.guard`).
 */

import type { SettingColumnAdapter } from "../../core/settings/types.js";

export const IDENTITY_COLUMN_ADAPTERS: Readonly<
  Record<string, SettingColumnAdapter>
> = {
  "identity.keyEntry.claimByKey": {
    table: "portal_product_settings",
    keyColumn: "product",
    columns: ["claim_by_key"],
    decode: (row) =>
      row && typeof row.claim_by_key === "number"
        ? row.claim_by_key === 1
        : undefined,
    // An upsert: the product may have no portal row yet, and every other column takes its default.
    set: ({ product, at, guard, value }) => [
      {
        sql: `INSERT INTO portal_product_settings (product, claim_by_key, created_at, modified_at)
              SELECT ?, ?, ?, ? WHERE (${guard.sql})
              ON CONFLICT(product) DO UPDATE SET
                claim_by_key = excluded.claim_by_key, modified_at = excluded.modified_at`,
        params: [product, value === true ? 1 : 0, at, at, ...guard.params],
      },
    ],
  },
};
