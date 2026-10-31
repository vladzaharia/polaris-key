-- Rollback of migration 0152_identity_restore_keys.sql. Only after rolling the Worker back to a
-- build that never names the tables. They hold hashed restore secrets and the devices that signed
-- in by restore; dropping them only means each device enrols a new key at its next check, and a
-- backup holding an old secret stops restoring.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0152_identity_restore_keys.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS identity_restore_origins;
DROP TABLE IF EXISTS identity_restore_keys;
