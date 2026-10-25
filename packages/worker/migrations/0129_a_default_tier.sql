-- LX-33.1: the schema for the implicit Default tier and the materialisation ledger.
--
-- `tiers.implicit` — 1 marks a product's Default tier: the row that holds the former product
-- licence defaults (`products.default_device_limit`, `default_max_offline_days`). A licence on it
-- renders as a tierless licence does, on devices and on customer surfaces, and a product has at
-- most one (`idx_tiers_implicit`). Every existing tier is 0. Nothing reads or writes the column
-- yet: seeding, the resolver and the console arrive in later LX-33 slices, and no upsert may
-- reset it (a console or manifest upsert names its columns, so a conflict update leaves it alone).
--
-- `license_limit_backfill` — the ledger of LX-33's P0-49 job: one row per (product, subject,
-- field) the job changed, with the value before and after, so the job's `down` is exact. It is
-- dropped after the release that retires the product defaults.
--
-- License owns both (`tiers` and the ledger are in TABLE_OWNERS under `license`). Expand-only: a
-- Worker deployed before this migration never names them. Rollback:
-- scripts/rollback/0129_a_default_tier.down.sql.
ALTER TABLE tiers ADD COLUMN implicit INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tiers_implicit ON tiers(product) WHERE implicit = 1;

CREATE TABLE IF NOT EXISTS license_limit_backfill (
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
