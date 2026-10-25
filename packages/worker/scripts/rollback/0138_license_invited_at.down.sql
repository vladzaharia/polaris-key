-- LX-27c.1 rollback: the `down` path of migration 0138_license_invited_at.sql.
--
-- WHEN. Only after rolling the Worker back to a build before LX-27c. That Worker never names the
-- column, so dropping it loses only the invitation dates.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0138_license_invited_at.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing. Exercised by
-- test/core/migrations/licenseInvitedAtMigration.test.ts.

ALTER TABLE licenses DROP COLUMN invited_at;
