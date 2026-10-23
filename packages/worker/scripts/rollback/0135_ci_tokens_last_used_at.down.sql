-- F-33b.2 rollback: the `down` path of migration 0135_ci_tokens_last_used_at.sql.
--
-- WHEN. Only after rolling the Worker back to a build before F-33b.2. That Worker never names the
-- column, so dropping it loses only the "last used" times of CI tokens.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0135_ci_tokens_last_used_at.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

ALTER TABLE ci_tokens DROP COLUMN last_used_at;
