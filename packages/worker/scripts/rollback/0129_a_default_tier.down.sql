-- LX-33.1 rollback: the `down` path of migrations 0129_a_default_tier.sql and
-- 0129_b_index_assertion.sql.
--
-- WHEN. Only after rolling the Worker back to a build before LX-33.1. That Worker never names the
-- column, the index or the ledger, so dropping them loses only the implicit-Default-tier marks and
-- the backfill ledger (take the ledger's rows first if the P0-49 job ever ran: it is the only
-- record of what to undo).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0129_a_default_tier.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.
--
-- The index assertion (0129_b) has no down of its own: 0119_b has none either. Its row in
-- `schema_index_assertion` is replaced by the next deploy, which re-runs the newest assertion
-- file; a Worker from before LX-33.1 ships 0119_b, whose list has no idx_tiers_implicit.

DROP TABLE IF EXISTS license_limit_backfill;
DROP INDEX IF EXISTS idx_tiers_implicit;
ALTER TABLE tiers DROP COLUMN implicit;
