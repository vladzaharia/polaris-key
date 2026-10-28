-- CC-07.2 (plans/CC-01-cloud-connect.md §2.9): the Cloud Connect relay's meter, one row per
-- product and UTC day. The relay rooms (Durable Objects) add to it from their alarm; the
-- product's monthly ceiling is read from it.
--
--   day       the UTC date, YYYY-MM-DD.
--   bytes     envelope bytes the relay carried for the product that day, all people together.
--   sessions  relay connections admitted that day.
--
-- Counters only: no subject, no device. Owned by connect (TABLE_OWNERS). Not a subject store.
-- Expand-only: a Worker built before this migration never names the table. Rollback:
-- scripts/rollback/0147_connect_relay_daily.down.sql.
CREATE TABLE IF NOT EXISTS connect_relay_daily (
  product  TEXT NOT NULL,
  day      TEXT NOT NULL,
  bytes    INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, day)
);
