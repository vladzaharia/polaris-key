-- HA-07 (notes/S-20 §6.2, §8) — `dist_listing_assets.source` learns `manifest`.
--
-- The store-facing listing model (A-18b) now also holds the art a product's manifest declares:
-- Polaris Key's hosted copies (HA-01, HA-05) of `.pkey/distribution` `listing.icon`, `header` and
-- `screenshots[]`, written as `source = 'manifest'` rows by Distribution
-- (`services/distribution/listing/manifestAssets.ts`), so the storefront pushers can use art a
-- manifest declares. A manifest row never replaces an `admin` row (an operator's upload) or an
-- `import` row (A-18d's store-exact CI derivation); it holds a `listing-asset` ref like every row.
--
-- 0065 pinned `CHECK (source IN ('admin', 'import'))`, and SQLite cannot change a CHECK in place,
-- so the table is rebuilt with `'manifest'` added; every column (0065's and 0083's acceptance
-- columns) is copied unchanged. No table holds a foreign key into it and it has no index of its
-- own, so nothing is set aside first (0058_b's child-row step is not needed).
--
-- EVERY STEP IS REPLAY-SAFE (the 0017 / 0058_b discipline: D1 may run this file with no wrapping
-- transaction, so it must converge from any point it dies at):
--
--   * `CREATE TABLE IF NOT EXISTS dist_listing_assets`, FIRST, closes the window between the drop
--     and the rename: a replay recreates the original empty, copies nothing into a `_v2` that
--     holds every row already, drops the shell and renames `_v2` into place;
--   * the copy is `INSERT OR IGNORE` (the primary key), so a replay that copies twice is harmless.
--
-- Forward-only, like 0058_b: an older Worker reads and writes the table unchanged (no column is
-- renamed or removed), but rolling the SCHEMA back past this file needs the `manifest` rows
-- removed first (their refs are dropped with them; the collector reclaims the bytes).

CREATE TABLE IF NOT EXISTS dist_listing_assets (
  product      TEXT NOT NULL REFERENCES products(slug),
  slot         TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT '',
  blob         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  alpha        INTEGER NOT NULL DEFAULT 0 CHECK (alpha IN (0, 1)),
  derived_from TEXT,
  text_allowed TEXT NOT NULL CHECK (text_allowed IN ('none', 'title', 'free')),
  source       TEXT NOT NULL CHECK (source IN ('admin', 'import')),
  modified_at  INTEGER NOT NULL,
  modified_by  TEXT NOT NULL,
  accepted_sha256 TEXT,
  accepted_at  INTEGER,
  accepted_by  TEXT,
  PRIMARY KEY (product, slot, locale)
);

CREATE TABLE IF NOT EXISTS dist_listing_assets_v2 (
  product      TEXT NOT NULL REFERENCES products(slug),
  slot         TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT '',
  blob         TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  alpha        INTEGER NOT NULL DEFAULT 0 CHECK (alpha IN (0, 1)),
  derived_from TEXT,
  text_allowed TEXT NOT NULL CHECK (text_allowed IN ('none', 'title', 'free')),
  source       TEXT NOT NULL CHECK (source IN ('admin', 'import', 'manifest')),
  modified_at  INTEGER NOT NULL,
  modified_by  TEXT NOT NULL,
  accepted_sha256 TEXT,
  accepted_at  INTEGER,
  accepted_by  TEXT,
  PRIMARY KEY (product, slot, locale)
);

INSERT OR IGNORE INTO dist_listing_assets_v2
  (product, slot, locale, blob, sha256, width, height, alpha, derived_from, text_allowed, source,
   modified_at, modified_by, accepted_sha256, accepted_at, accepted_by)
SELECT product, slot, locale, blob, sha256, width, height, alpha, derived_from, text_allowed, source,
       modified_at, modified_by, accepted_sha256, accepted_at, accepted_by
  FROM dist_listing_assets;

DROP TABLE dist_listing_assets;

ALTER TABLE dist_listing_assets_v2 RENAME TO dist_listing_assets;
