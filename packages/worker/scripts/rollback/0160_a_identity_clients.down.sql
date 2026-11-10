-- Rollback of migration 0160_a_identity_clients.sql. Only after rolling the Worker back to a build
-- that never names the tables. They hold the registered clients and the peppered hashes of their
-- secrets; dropping them removes every client (the developer registers them again) and no
-- secret survives.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0160_a_identity_clients.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS identity_client_secrets;
DROP TABLE IF EXISTS identity_clients;
