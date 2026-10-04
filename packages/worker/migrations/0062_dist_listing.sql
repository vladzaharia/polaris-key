-- PX-W1 (docs/design/PORTAL.md G1, G16): the product's own store listing, as `.pkey/distribution`
-- declares it at the document's root — the customer portal's product presentation (name,
-- developer, tint, website, art URLs, support links).
--
-- `dist_outlets.listing_json` already holds a listing, but per outlet and MERGED with that
-- outlet's override, so "the product's listing" was not stored anywhere: picking one outlet's
-- merged copy would show the portal an App-Store-only subtitle the day a developer overrides one.
-- One row per product, Distribution-owned (`TABLE_OWNERS.distribution` in the docs generator),
-- written only by Distribution's manifest ingest (`services/distribution/outlets.ts`) and read
-- only through the `delivery` hook's `listing()`, so Identity (the portal) never queries it.
--
--   listing_json   the normalised root listing (`normalizeListing`), never an outlet override;
--                  the row is deleted when the document declares no listing
--   modified_at    the ingest that last CHANGED it (an identical resync touches nothing)
CREATE TABLE IF NOT EXISTS dist_listing (
  product      TEXT PRIMARY KEY REFERENCES products(slug) ON DELETE CASCADE,
  listing_json TEXT NOT NULL,
  modified_at  INTEGER NOT NULL
);
