-- I-30 rollback: the `down` path of migration 0112_identity_connections.sql (plans/I-27.md §9).
--
-- WHEN. Only after rolling the Worker back to a build before I-30. That Worker never names either
-- table, and the `PLATFORM_OIDC_*` trio is still set (I-32b removes it), so dropping them loses
-- only the connections and domain proofs I-30 added.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0112_identity_connections.down.sql
-- Idempotent: every statement is `IF EXISTS`.

DROP INDEX IF EXISTS idx_identity_connection_domains_owner;
DROP TABLE IF EXISTS identity_connection_domains;
DROP TABLE IF EXISTS identity_connections;
