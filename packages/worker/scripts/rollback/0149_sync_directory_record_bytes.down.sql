-- U-09.9 rollback: the `down` path of migration 0149_sync_directory_record_bytes.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-09.9. That Worker never names the
-- column, so dropping it loses only the records' share of each person's bytes in the directory
-- (the objects still hold it, and the next flush of a newer build writes it again).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0149_sync_directory_record_bytes.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

ALTER TABLE sync_directory DROP COLUMN record_bytes;
