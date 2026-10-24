-- ST-25.3: drop the stores that have been dead since ST-11 (0124) and ST-14 (0126).
--
-- Contract step. Both moved their values into `product_settings` rows once and no code reads the
-- old stores any more:
--   lazy_delta_settings, email_product_caps    -> product_settings deltas.lazy.* / email.dailyCap (0124)
--   products.branding_json                     -> portal_product_settings.branding_json (0126; always
--                                                 NULL in production; the Locker never read it)
--   portal_product_settings.oidc_enabled, magic_enabled, license_key_claim_enabled, releases_enabled,
--   auto_link_enabled                          -> retired by I-29, unread since
-- `portal_enabled`, `key_reissue_enabled` and `claim_by_key` stay for one more release (ST-14 moved
-- their values to settings rows; the rows are the truth, the columns are the rollback copy).
--
-- Rollback: scripts/rollback/0140_retire_legacy_settings.down.sql recreates the tables EMPTY and the
-- columns with their old defaults. The values are not restored; they live in `product_settings`.
-- The production rollback targets (v0.9.15, v0.9.16) already contain ST-11 and ST-14 and read none
-- of these.

DROP TABLE IF EXISTS lazy_delta_settings;
DROP TABLE IF EXISTS email_product_caps;

ALTER TABLE portal_product_settings DROP COLUMN oidc_enabled;
ALTER TABLE portal_product_settings DROP COLUMN magic_enabled;
ALTER TABLE portal_product_settings DROP COLUMN license_key_claim_enabled;
ALTER TABLE portal_product_settings DROP COLUMN releases_enabled;
ALTER TABLE portal_product_settings DROP COLUMN auto_link_enabled;

ALTER TABLE products DROP COLUMN branding_json;
