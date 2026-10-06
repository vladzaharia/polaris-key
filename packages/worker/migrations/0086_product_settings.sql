-- ST-01b (notes/S-18 §2.1, §4.3, §4.5; owner decision 1, model C): product settings and claims.
--
-- 1. `product_settings` — the single per-product settings table, in its FINAL shape (S-18 §4.3), so
--    no later package re-migrates the keys it holds. Two storage kinds share one row shape:
--
--      * column-backed keys keep their value in an existing typed column, read on device hot paths,
--        and the row holds only the claim (`source`, `version`, author, reason, expiry). ST-01b's
--        five: `core.name`, `license.defaults.maxOfflineDays`, `license.defaults.deviceLimit`,
--        `core.web.origins` (all on `products`) and `config.catalog` (the active `product_schema`).
--        Column-backed is permanent: those columns are never migrated, `value_json` stays NULL;
--      * row-backed keys (ST-04's resolver, I-09, U-05, LX-06) keep their value in `value_json`.
--
--    Absence of a row means MANIFEST for a claimable key (and "inherit" for an operator key). A
--    console write to a claimable key upserts a `source = 'console'` row, which every later resync
--    skips; Revert deletes the row and re-applies the manifest snapshot (ST-01a). `expires_at` is
--    reserved for ST-20's break-glass claims on the system product; nothing writes it yet.
--
-- 2. Per-row `source` on `tiers` and `profiles` in the final vocabulary. Existing rows read
--    'manifest' (the DEFAULT), so until ST-01c's backfill runs a product behaves as before: a
--    resync owns every row it declares. The console writes 'console' from now on; a resync upserts
--    only its own rows, leaves console rows alone, and deletes a manifest row only when the
--    manifest dropped it and nothing references it.
--
-- No ON DELETE, unlike the sketch in S-18 §4.3: like every other product-scoped table (and ST-01a's
-- `product_manifest_snapshot`), the row references `products(slug)` plainly (R11-01,
-- `test/attack/R11-data.test.ts`; products are never hard-deleted).
--
-- Expand-only: a new table and two defaulted columns. A Worker deployed before this migration never
-- names the table and writes neither column (the DEFAULT fills it), so it keeps working.
--
-- Rollback: a pre-ST-01b Worker ignores all three, so no SQL is needed. To remove them anyway:
--   DROP TABLE product_settings;
--   ALTER TABLE tiers DROP COLUMN source;
--   ALTER TABLE profiles DROP COLUMN source;

CREATE TABLE IF NOT EXISTS product_settings (
  product     TEXT NOT NULL REFERENCES products(slug),
  key         TEXT NOT NULL,
  value_json  TEXT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manifest','console')),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  reason      TEXT NULL,
  expires_at  INTEGER NULL,
  PRIMARY KEY (product, key)
);

ALTER TABLE tiers ADD COLUMN source TEXT NOT NULL DEFAULT 'manifest'
  CHECK (source IN ('manifest','console'));

ALTER TABLE profiles ADD COLUMN source TEXT NOT NULL DEFAULT 'manifest'
  CHECK (source IN ('manifest','console'));
