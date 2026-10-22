-- A-27.6 (A-27, "one listing truth"): the ledger of the backfill job `distribution.listing-truth`.
--
-- The job copies the root listing's text from `dist_listing` (the manifest blob) into the listing
-- model (`dist_listings*`) so the model is the one place the portal and discovery read. Because
-- this is customer-visible data, each model field the apply writes is recorded here FIRST, with
-- what it replaced, so `down` can put it back (D9). One row per product, locale and field; the
-- app-level fields use locale `''`.
--
--   had_row           1 when the model had a value for the field before the apply, else 0
--   prior_value_json  the value the field held (JSON), NULL when it had none
--   prior_provenance  the import source recorded for it before (`manifest`, `app-store`, …), or NULL
--   applied_value_json what the apply wrote (JSON); `down` restores only while the field still holds it
--   moved_at          epoch seconds of the apply
--
-- Distribution owns the table (`TABLE_OWNERS`). Expand-only: a new table nothing older reads.
-- Rollback: scripts/rollback/0199_listing_truth_moves.down.sql.
CREATE TABLE IF NOT EXISTS dist_listing_truth_moves (
  product            TEXT NOT NULL REFERENCES products(slug),
  locale             TEXT NOT NULL DEFAULT '',
  field              TEXT NOT NULL,
  had_row            INTEGER NOT NULL CHECK (had_row IN (0, 1)),
  prior_value_json   TEXT,
  prior_provenance   TEXT,
  applied_value_json TEXT,
  moved_at           INTEGER NOT NULL,
  PRIMARY KEY (product, locale, field)
);
