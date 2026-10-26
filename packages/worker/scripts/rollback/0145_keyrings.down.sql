-- U-36.1 rollback: the `down` path of migration 0145_keyrings.sql.
--
-- WHEN. Only after rolling the Worker back to a build before U-36. That Worker never names the
-- tables, so dropping them loses the rings, wraps and sealed recovery blobs. That is data a
-- device cannot restore from the server: a device that still holds its root can create a ring
-- again, but one whose only copy was the recovery blob needs the recovery code. Run it only when
-- no end-to-end data depends on the ring.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0145_keyrings.down.sql
-- It is idempotent. Exercised by test/core/keyring/keyringMigration.test.ts.

DROP INDEX IF EXISTS idx_keyring_wraps_device;
DROP TABLE IF EXISTS keyring_adopted;
DROP TABLE IF EXISTS keyring_wraps;
DROP TABLE IF EXISTS keyrings;
