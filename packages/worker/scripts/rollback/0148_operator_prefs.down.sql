-- Rollback of migration 0148_operator_prefs.sql. Only after rolling the Worker back to a build
-- that never names the table; it holds operators' console preferences, which fall back to
-- this browser's own setting.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0148_operator_prefs.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS operator_prefs;
