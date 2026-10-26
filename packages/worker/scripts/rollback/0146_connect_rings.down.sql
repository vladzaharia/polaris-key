-- Rollback of migration 0146_connect_rings.sql. Only after rolling the Worker back to a build
-- that never names the table; it holds a roster epoch and a discovery key per person, which the
-- next identity fetch re-creates (devices then hold a new key).
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0146_connect_rings.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS connect_rings;
