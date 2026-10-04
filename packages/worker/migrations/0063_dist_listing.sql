-- A-18b (notes/S-15 §7.1, §5.5): the shared listing model. Each product has ONE listing, entered
-- once or imported, from which every store's listing is projected (`core/storefront/projection.ts`
-- against each store's limits in `core/storefront/listingProfiles.ts`). Five Distribution tables
-- (`TABLE_OWNERS.distribution` in the docs generator), written only by
-- `services/distribution/listing/**`. They are operator data, not a manifest: `.pkey/distribution`
-- `listing` stays an import source (and the feeds' fallback), and nothing here is signed or on the
-- wire. Every write is audited (`distribution.listing.*`).
--
-- `source` is `admin` (typed in the console) or `import` (copied from an import source:
-- `.pkey/distribution` here; the stores and the Godot project in A-18c). An import never overwrites
-- a non-empty `admin` value. Listing text is DATA: stored as typed, rendered escaped, never as
-- HTML. Values are never truncated to fit: the model's own limits are enforced on every write
-- (`core/storefront/listingModel.ts`), and a store's tighter limit is a fit-report issue, not a cut.
--
-- `dist_listings` — one row per product: the app-level fields.
--   default_locale           the locale the app-level name belongs to (BCP 47, e.g. `en-US`)
--   name                     ≤ 30 (Apple and Play)
--   developer_name           the publisher name the stores show
--   category                 a canonical category id, mapped per store by its adapter
--   content_descriptors_json the answers stores' rating questionnaires share (S-15 §5.2), JSON
--   iarc_certificate_id      an IARC certificate, once one exists
--   urls_json                `{website?, support?, privacy?, marketing?, eula?}`, https only
--   contact_email, copyright
--   tint, tint_dark          `#rrggbb` (Flathub needs both; AltStore uses `tint`)
--   precedence_json          per field, the import sources in the order they win (S-15 §7.2:
--                            "the store that is live wins" by default); NULL is the default order
CREATE TABLE IF NOT EXISTS dist_listings (
  product                  TEXT NOT NULL REFERENCES products(slug),
  default_locale           TEXT NOT NULL,
  name                     TEXT,
  developer_name           TEXT,
  category                 TEXT,
  content_descriptors_json TEXT,
  iarc_certificate_id      TEXT,
  urls_json                TEXT,
  contact_email            TEXT,
  copyright                TEXT,
  tint                     TEXT,
  tint_dark                TEXT,
  precedence_json          TEXT,
  source                   TEXT NOT NULL CHECK (source IN ('admin', 'import')),
  created_at               INTEGER NOT NULL,
  modified_at              INTEGER NOT NULL,
  modified_by              TEXT NOT NULL,
  PRIMARY KEY (product)
);

-- `dist_listing_locales` — the per-locale text. `name` overrides the app-level name in that
-- locale. Limits: subtitle ≤ 30, short_description ≤ 78 (Snap's, inside Play's 80), description
-- ≤ 4,000 (Apple and Play), features ≤ 20 × 200 (Microsoft), promotional_text ≤ 170 (Apple).
-- `keywords_json` and `features_json` are JSON arrays of strings.
CREATE TABLE IF NOT EXISTS dist_listing_locales (
  product           TEXT NOT NULL REFERENCES products(slug),
  locale            TEXT NOT NULL,
  name              TEXT,
  subtitle          TEXT,
  short_description TEXT,
  description       TEXT,
  keywords_json     TEXT,
  features_json     TEXT,
  promotional_text  TEXT,
  source            TEXT NOT NULL CHECK (source IN ('admin', 'import')),
  modified_at       INTEGER NOT NULL,
  modified_by       TEXT NOT NULL,
  PRIMARY KEY (product, locale)
);

-- `dist_listing_assets` — one image (or the trailer link) per slot and locale (`''`: every
-- locale). `blob` is the blob store's key and `sha256` the bytes' digest (A-18d's derivation
-- uploads them; the Worker never makes images). `text_allowed` is the slot's rule, `none`
-- (Steam's library hero, Microsoft's super hero), `title` (capsules, the poster) or `free`.
-- `derived_from` names the slot an output was derived or composed from.
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
  PRIMARY KEY (product, slot, locale)
);

-- `dist_listing_release_notes` — per-release, per-locale store notes (S-15 §5.5). A release
-- without a row shows a DEFAULT, never stored: its release notes (`release_metadata.notes`) with
-- Markdown stripped, plus a sentence-boundary cut to 500 proposed for edit. `text` is ≤ 10,000
-- (winget's, the largest store limit); `short` is ≤ 500, for Play and F-Droid. Stored here, not in
-- the signed release descriptor, so no manifest or wire change is involved.
CREATE TABLE IF NOT EXISTS dist_listing_release_notes (
  product     TEXT NOT NULL REFERENCES products(slug),
  release_id  TEXT NOT NULL,
  locale      TEXT NOT NULL,
  text        TEXT NOT NULL,
  short       TEXT,
  source      TEXT NOT NULL CHECK (source IN ('admin', 'import')),
  modified_at INTEGER NOT NULL,
  modified_by TEXT NOT NULL,
  PRIMARY KEY (product, release_id, locale)
);

-- `dist_listing_overrides` — a per-store replacement for one model field, in one locale (`''`:
-- every locale), e.g. a Steam short description longer than the model's 78. `value_json` is the
-- replacement (a JSON string, or a JSON array for keywords and features). An override bypasses
-- the model's limit, never the store's: the projection checks it against that store's column.
CREATE TABLE IF NOT EXISTS dist_listing_overrides (
  product     TEXT NOT NULL REFERENCES products(slug),
  store       TEXT NOT NULL,
  locale      TEXT NOT NULL DEFAULT '',
  field       TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('admin', 'import')),
  modified_at INTEGER NOT NULL,
  modified_by TEXT NOT NULL,
  PRIMARY KEY (product, store, locale, field)
);
