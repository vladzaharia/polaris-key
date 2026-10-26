-- CC-03.1 rollback: the `down` path of migration 0143_a_device_keys.sql.
--
-- WHEN. Only after rolling the Worker back to a build before CC-03. That Worker never names the
-- table, so dropping it loses only the registered device keys; each device registers again on its
-- next need (keys are generated on first use), so no data is lost that a device cannot restore.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0143_a_device_keys.down.sql
-- It is idempotent. Exercised by test/core/migrations/deviceKeysMigration.test.ts.

DROP INDEX IF EXISTS idx_device_keys_agree;
DROP TABLE IF EXISTS device_keys;
