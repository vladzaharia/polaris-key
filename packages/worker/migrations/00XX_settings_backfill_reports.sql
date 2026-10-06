-- ST-01c (notes/S-18 §4.14; owner decision D19, "Revert all console values"): the settings
-- backfill's reports, kept for the record.
--
-- The backfill moves every product onto ST-01b's claim model once: each manifest-declared field
-- and tier/profile row of a linked product takes its manifest value, and console-only rows the
-- manifest does not declare are kept as `source = 'console'`. Every run, dry or applied, stores
-- one row here per product it looked at:
--
--   mode         'dry-run' (classified, nothing else written) or 'apply' (written in the same
--                `db.batch` as the apply, FIRST, so the report row exists exactly when the apply
--                landed; see `core/settingsBackfill.ts` for the state guard on that row);
--   outcome      'planned' (a dry run that classified the product), 'applied' (an apply that
--                changed something), 'unchanged' (an apply that changed nothing: the idempotent
--                second run), 'unlinked' (no manifest exists: nothing classified), 'unreadable'
--                (`.pkey/` could not be read: nothing written but this row) or 'refused' (the
--                manifest was read but cannot be applied, e.g. a catalog the validator refuses);
--   batch_id     the platform batch that ran it, NULL for a single-product run;
--   commit_sha   the default-branch commit the manifest was read at (the deploy's commit for the
--                system product, whose manifest is its deploy-hook snapshot), NULL when none;
--   changes      how many items the apply changes (a dry run: would change);
--   report_json  the classification (equal / differs / not declared per field and row, with the
--                audit evidence and the corroboration), the action per item and the before and
--                after values. Profile payloads appear as key names only and secrets never appear:
--                the report holds no secret material.
--
-- Append-only and never pruned (the record outlives the 180-day audit window). Like every
-- product-scoped table it references the product without `ON DELETE` (R11-01): products are
-- never hard-deleted.
--
-- Expand-only: a new table. A Worker deployed before this migration never names it.
--
-- Rollback: a pre-ST-01c Worker ignores the table, so no SQL is needed. To drop it anyway (the
-- reports are lost; the settings the backfill wrote stay as written):
--   DROP INDEX idx_settings_backfill_reports_at;
--   DROP TABLE settings_backfill_reports;

CREATE TABLE IF NOT EXISTS settings_backfill_reports (
  product      TEXT NOT NULL REFERENCES products(slug),
  id           TEXT NOT NULL,
  at           INTEGER NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('dry-run','apply')),
  outcome      TEXT NOT NULL
               CHECK (outcome IN ('planned','applied','unchanged','unlinked','unreadable','refused')),
  batch_id     TEXT NULL,
  commit_sha   TEXT NULL,
  changes      INTEGER NOT NULL DEFAULT 0,
  actor_sub    TEXT NULL,
  actor_name   TEXT NULL,
  report_json  TEXT NOT NULL,
  PRIMARY KEY (product, id)
);

CREATE INDEX IF NOT EXISTS idx_settings_backfill_reports_at
  ON settings_backfill_reports(product, at DESC);
