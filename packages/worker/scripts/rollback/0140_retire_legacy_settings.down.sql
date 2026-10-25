-- Rollback of 0140_retire_legacy_settings.sql. Recreates the two tables EMPTY and the six columns
-- with the defaults they had. Nothing is restored: the values live in `product_settings` rows
-- (migrations 0124, 0126), which the pre-0140 Worker reads through the same readers.
CREATE TABLE IF NOT EXISTS lazy_delta_settings (
  product      TEXT PRIMARY KEY REFERENCES products(slug),
  enabled      INTEGER NOT NULL DEFAULT 0,
  hot_devices  INTEGER,
  daily_cap    INTEGER,
  updated_at   INTEGER NOT NULL,
  CHECK (enabled IN (0, 1)),
  CHECK (hot_devices IS NULL OR hot_devices >= 1),
  CHECK (daily_cap IS NULL OR daily_cap >= 0)
);

CREATE TABLE IF NOT EXISTS email_product_caps (
  product     TEXT PRIMARY KEY,
  daily_cap   INTEGER NOT NULL CHECK (daily_cap > 0),
  modified_at INTEGER NOT NULL
);

ALTER TABLE portal_product_settings ADD COLUMN oidc_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_product_settings ADD COLUMN magic_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_product_settings ADD COLUMN license_key_claim_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_product_settings ADD COLUMN releases_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_product_settings ADD COLUMN auto_link_enabled INTEGER;

ALTER TABLE products ADD COLUMN branding_json TEXT;
