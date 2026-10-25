-- U-05.3 rollback: the `down` path of migration 0132_cloud_sync_daily.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-05.3. The rows are daily counters,
-- not content; dropping them loses the console's sync-activity history.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0132_cloud_sync_daily.down.sql
-- It is idempotent (IF EXISTS).

DROP TABLE IF EXISTS sync_product_daily;
