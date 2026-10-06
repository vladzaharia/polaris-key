-- PS-02 (notes/S-21 §6.2, owner decision 3): the Polaris Key storefront's listing state.
--
-- Four columns on `portal_product_settings`, beside `discover_enabled` (0071), backing the settings
-- registry entries `storefront.polarisKey.{listed,audience,offerPaths,groupLabels}`:
--
--   store_listed            'auto' | 'listed' | 'unlisted'. Default 'auto', which reproduces
--                           today's Discover exactly, so nothing appears or disappears on deploy.
--   store_audience          'eligible' | 'everyone'. 'everyone' is the one deliberate exception
--                           to "no enumeration", set by an operator with a level-2 confirmation.
--   store_offer_paths_json  a JSON array of obtain-path kinds; NULL = every kind.
--   store_group_labels_json a JSON object {<group>: <label>}; NULL = no labels.
--
-- Backfill: a product that opted out of Discover (`discover_enabled = 0`) is 'unlisted'. The
-- Worker keeps reading `discover_enabled` until PS-11 (dual-read: 0 forces 'unlisted'), and keeps
-- the two in step when it writes either.
--
-- Expand-only: columns with constant defaults on an existing table, and an UPDATE of the new column
-- only. A Worker deployed before this migration names none of them: its INSERT takes the defaults,
-- its ON CONFLICT update leaves them alone, and its `SELECT *` gains fields it ignores.
--
-- Rollback: a pre-PS-02 Worker ignores all four columns, so no SQL is needed. To drop them anyway:
--   ALTER TABLE portal_product_settings DROP COLUMN store_listed;
--   ALTER TABLE portal_product_settings DROP COLUMN store_audience;
--   ALTER TABLE portal_product_settings DROP COLUMN store_offer_paths_json;
--   ALTER TABLE portal_product_settings DROP COLUMN store_group_labels_json;

ALTER TABLE portal_product_settings ADD COLUMN store_listed TEXT NOT NULL DEFAULT 'auto'
  CHECK (store_listed IN ('auto', 'listed', 'unlisted'));
ALTER TABLE portal_product_settings ADD COLUMN store_audience TEXT NOT NULL DEFAULT 'eligible'
  CHECK (store_audience IN ('eligible', 'everyone'));
ALTER TABLE portal_product_settings ADD COLUMN store_offer_paths_json TEXT;
ALTER TABLE portal_product_settings ADD COLUMN store_group_labels_json TEXT;

UPDATE portal_product_settings SET store_listed = 'unlisted' WHERE discover_enabled = 0;
