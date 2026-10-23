-- ST-31 rollback: the `down` path of migration 0129_a_console_role_bindings.sql.
--
-- WHEN. Only after rolling the Worker back to a build before ST-31 slice 2 (the principal's
-- reader). That Worker never names the table; dropping it loses every stored role binding and
-- pending invite, so the console falls back to the root rule alone.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0129_a_console_role_bindings.down.sql
-- It is idempotent (IF EXISTS); dropping the table drops its indexes.

DROP INDEX IF EXISTS idx_crb_scope;
DROP INDEX IF EXISTS idx_crb_email;
DROP INDEX IF EXISTS idx_crb_account;
DROP TABLE IF EXISTS console_role_bindings;
