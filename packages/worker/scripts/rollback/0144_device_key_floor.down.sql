-- Rollback of migration 0144_device_key_floor.sql. Only after rolling the Worker back to a build
-- that never names the table; it holds counters a device re-establishes on its next registration.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0144_device_key_floor.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS device_key_floor;
