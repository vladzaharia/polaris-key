-- Rollback of migration 0162_c_identity_client_grants.sql. Only after rolling the Worker back to a
-- build that never names the table. Dropping it forgets every person's decision for every
-- registered client: each is asked again at its next sign-in.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0162_c_identity_client_grants.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS identity_client_grants;
