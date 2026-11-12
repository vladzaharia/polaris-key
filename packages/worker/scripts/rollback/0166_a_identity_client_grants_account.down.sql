-- Rollback of migration 0166_a_identity_client_grants_account.sql. The index is only a read path;
-- dropping it changes no row. Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0166_a_identity_client_grants_account.down.sql
-- It is idempotent.

DROP INDEX IF EXISTS identity_client_grants_account;
