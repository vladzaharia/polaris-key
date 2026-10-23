-- U-05.3 rollback: the `down` path of migration 0131_cloud_sync_directory.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-05.3 (or with Cloud Sync off for
-- good). The directory is derived: every counter is rewritten from the per-person Durable Object
-- at its next write, so dropping it loses only the directory's listing until then.
--
-- CAUTION. The directory is also the only enumeration of the per-person objects: a product's
-- deletion purge (services/sync/productDeletion.ts) finds the objects to erase through it, and an
-- object cannot be listed. Dropping the table blinds the purge, so a product deleted afterwards
-- leaves its objects behind. Delete the products you mean to delete first, or keep the table.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0131_cloud_sync_directory.down.sql
-- It is idempotent (IF EXISTS).

DROP INDEX IF EXISTS idx_sync_directory_active;
DROP TABLE IF EXISTS sync_directory;
DROP TABLE IF EXISTS sync_product_usage;
