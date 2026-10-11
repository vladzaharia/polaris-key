-- F-36 rollback: the `down` path of migration 00XX_release_package_retention_notices.sql.
--
-- WHEN. Only after rolling the Worker back to a build before F-36. That Worker never names the
-- table, and it prunes only where a product opted in, so dropping the notices loses only the
-- record of who was told, and cleanup stays off for a product that never chose.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/00XX_release_package_retention_notices.down.sql
-- Idempotent: the statement is `IF EXISTS`.

DROP TABLE IF EXISTS release_package_retention_notices;
