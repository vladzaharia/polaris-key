-- LX-34.2: the entitlement catalog in Licensing, and the bucket job's ledger.
--
-- `license_entitlements` - one row per entitlement a product declares (`licensing.entitlements[]`
-- in its manifest, or the console): a feature flag, a quantity or a consumable. `label`,
-- `description` and `shown_to_customers` are presentation; `schema_json` and `default_json` the
-- value's JSON Schema fragment and default; `position` keeps the declared order. `source` is the
-- row's owner (a resync leaves a `console` row alone). Nothing reads or writes the table yet
-- (LX-34.5 ingests it).
--
-- `entitlement_bucket_backfill` - the ledger of the P0-49 job `license.entitlement-buckets`: one
-- row per (product, subject, field) the job changed, with the value before (the first, kept) and
-- the value last written, so the job's `down` is exact. Dropped after the release that switches the
-- reads (LX-34.10).
--
-- License owns both (TABLE_OWNERS). Expand-only: a Worker deployed before this migration never
-- names them. Replay-safe. Provisional number; the lead numbers it at merge.
-- Rollback: scripts/rollback/0160_entitlement_buckets.down.sql.
CREATE TABLE IF NOT EXISTS license_entitlements (
  product            TEXT NOT NULL,
  key                TEXT NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'feature' CHECK (kind IN ('feature', 'quantity', 'consumable')),
  label              TEXT,
  description        TEXT,
  schema_json        TEXT,
  default_json       TEXT,
  shown_to_customers INTEGER NOT NULL DEFAULT 0 CHECK (shown_to_customers IN (0, 1)),
  position           INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL DEFAULT 'manifest' CHECK (source IN ('manifest', 'console')),
  modified_by        TEXT,
  modified_at        INTEGER NOT NULL,
  PRIMARY KEY (product, key)
);

CREATE TABLE IF NOT EXISTS entitlement_bucket_backfill (
  product      TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('license', 'tier')),
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  before_json  TEXT,
  after_json   TEXT,
  run_id       TEXT NOT NULL,
  at           INTEGER NOT NULL,
  PRIMARY KEY (product, subject_kind, subject_id, field)
);
