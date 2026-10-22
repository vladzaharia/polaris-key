-- F-33b.4 rollback: the `down` path of migration 0130_ci_tokens_hint.sql.
--
-- WHEN. Only after rolling the Worker back to a build before this change. That Worker never names
-- the column, so dropping it loses only the token hints.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0130_ci_tokens_hint.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

ALTER TABLE ci_tokens DROP COLUMN hint;
