-- I-33 rollback: the `down` path of migration 0110_accounts_birthdate.sql (plans/I-27.md §9).
--
-- WHEN. Only after rolling the Worker back to a build before I-33, and after
-- 0111_accounts_birthdate_source.down.sql. That Worker never names the column, so dropping it
-- loses only the birth dates people added, which is the point of a rollback that erases them.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0110_accounts_birthdate.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing. Exercised by
-- test/accountBirthdate.test.ts.

ALTER TABLE accounts DROP COLUMN birthdate;
