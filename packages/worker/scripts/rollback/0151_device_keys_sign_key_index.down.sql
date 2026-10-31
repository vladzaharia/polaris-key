-- Rollback of migration 0151_device_keys_sign_key_index.sql.
--
-- WHEN. Only after rolling the Worker back to a build that does not look keys up by signing key.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0151_device_keys_sign_key_index.down.sql
-- It is idempotent.

DROP INDEX IF EXISTS idx_device_keys_sign;
