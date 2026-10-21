-- ST-30 rollback: the `down` path of migration 0128_console_strong_method.sql.
--
-- WHEN. Only after rolling the Worker back to a build before ST-30 slice 2b. That Worker never
-- names either column, so dropping them loses only which methods were marked for the console and
-- when groups were last asserted (every operator signs in once more).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0128_console_strong_method.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

DROP INDEX IF EXISTS idx_account_links_member;
ALTER TABLE account_links DROP COLUMN member_id;
ALTER TABLE account_links DROP COLUMN strong_at;
ALTER TABLE account_links DROP COLUMN asserted_at;
