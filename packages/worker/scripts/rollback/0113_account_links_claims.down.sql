-- I-30 rollback: the `down` path of migration 0113_account_links_claims.sql (plans/I-27.md §9).
--
-- WHEN. Only after rolling the Worker back to a build before I-30, which never names the column.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0113_account_links_claims.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

ALTER TABLE account_links DROP COLUMN claims_json;
