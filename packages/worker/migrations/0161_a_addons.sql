-- LX-35.1: add-on definitions, and the ledger of the add-on backfill job.
--
-- `addons` - one row per add-on a product sells or comps (`licensing.addons[]` in its manifest,
-- or the console): a label plus the entitlements it grants (`entitlements_json`, a managed-payload
-- `entitlements` map), or `units` for a consumable; a `deviceLimit` add-on is a seat pack. A grant
-- references its add-on (`grants.addon_id`, 0161_b) and the resolver reads the add-on's keys live.
-- `source` is the row's owner (a resync leaves a `console` row alone). Nothing reads or writes the
-- table yet (LX-35.3 adds the store).
--
-- `addon_backfill` - the ledger of the P0-49 job `license.addons-backfill` (LX-35.6): one row per
-- (product, subject, field) the job changed, with the value before (the first, kept) and the value
-- last written, so the job's `down` is exact. Dropped after the release that makes `addon_id`
-- required (LX-35.10).
--
-- License owns both (TABLE_OWNERS). Expand-only: a Worker deployed before this migration never
-- names them. Replay-safe. Provisional number; the lead numbers it at merge.
-- Rollback: scripts/rollback/0161_addons.down.sql.
CREATE TABLE IF NOT EXISTS addons (
  product           TEXT NOT NULL,
  id                TEXT NOT NULL,
  label             TEXT NOT NULL,
  description       TEXT,
  entitlements_json TEXT NOT NULL DEFAULT '{}',
  units             INTEGER CHECK (units IS NULL OR units > 0),
  source            TEXT NOT NULL DEFAULT 'manifest' CHECK (source IN ('manifest', 'console')),
  modified_by       TEXT,
  modified_at       INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);

CREATE TABLE IF NOT EXISTS addon_backfill (
  product      TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('grant', 'addon')),
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  run_id       TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (product, subject_kind, subject_id, field)
);
