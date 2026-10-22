-- U-05.3 (plans/U-05-slices.md §3): Cloud Sync's daily activity per product.
--
-- One row per (product, UTC day 'YYYY-MM-DD'): `syncs` (accepted push and pull exchanges) and
-- `conflicts` (mutations answered `conflict`). Counters only, no subject, no content. Owned by
-- `sync`. No foreign keys. Rollback: scripts/rollback/0131_cloud_sync_daily.down.sql.
CREATE TABLE IF NOT EXISTS sync_product_daily (
  product   TEXT NOT NULL,
  day       TEXT NOT NULL,
  syncs     INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, day)
);
