-- U-05.3 rollback: the `down` path of migration 0130_cloud_sync_directory.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-05.3 (or with Cloud Sync off for
-- good). The directory is derived: every counter is rewritten from the per-person Durable Object
-- at its next write, so dropping it loses only the directory's listing until then.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0130_cloud_sync_directory.down.sql
-- It is idempotent (IF EXISTS).

DROP INDEX IF EXISTS idx_sync_directory_active;
DROP TABLE IF EXISTS sync_directory;
DROP TABLE IF EXISTS sync_product_usage;
