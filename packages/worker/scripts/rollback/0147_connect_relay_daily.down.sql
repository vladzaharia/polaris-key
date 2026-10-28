-- Rollback of migration 0147_connect_relay_daily.sql. Only after rolling the Worker back to a
-- build that never names the table; it holds relay usage counters, which are lost.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0147_connect_relay_daily.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS connect_relay_daily;
