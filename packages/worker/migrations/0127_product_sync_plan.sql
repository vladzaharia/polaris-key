-- ST-17 (S-18 §4.5 item 4): the dry-run plan the last apply recorded. Resync, link and the deploy
-- hook all apply through the core ingest pipeline, which writes the `ManifestPlan` it applied
-- (apply, skipClaimed, delete, conflicts, and the validator's warnings) here in the apply's own
-- batch, so the console's drift view and the sync log read what the apply did, not a re-derivation.
-- NULL: the product has not been applied since this column was added.
--
-- Core owns the table. ONE statement per file: a bare `ADD COLUMN` cannot be made idempotent in
-- SQLite (R11-04).
ALTER TABLE product_sync_state ADD COLUMN plan_json TEXT;
