-- U-05.3 (plans/U-05-slices.md §3; U-01b §6.1, R6): the Cloud Sync directory.
--
-- Cloud Sync keeps a person's data in a per-(product, subject) Durable Object. D1 holds only what
-- a list, a sort or a quota check must read without waking a thousand objects:
--
--   sync_directory      one row per (product, pairwise subject). Counters are the object's own,
--                       written by it after a push: `bytes` (settings + records + files),
--                       `settings`, `records`, `files` (counts), `revision_bytes` (history kept
--                       beyond the live copy), `quota_bytes` (the entitlement in force at the last
--                       write), `tier_id`, `platform` (the LAST platform seen, L7), `last_active_at`
--                       and `updated_at` (epoch seconds). Keyed by the pairwise subject, never by an
--                       account id (S-16 §5.1). Claimed by the `sync.cloudSync` subject store.
--   sync_product_usage  one row per product: the 15-minute aggregate over sync_directory. The
--                       breakdowns (by platform, tier and size band) are precomputed into
--                       `breakdown_json` (L6) so a console read never scans the directory.
--
-- Owned by `sync` (TABLE_OWNERS). No foreign keys and no cascades (R11-01). Expand-only: a Worker
-- built before this migration never names either table. Rollback:
-- scripts/rollback/0130_cloud_sync_directory.down.sql.
CREATE TABLE IF NOT EXISTS sync_directory (
  product        TEXT NOT NULL,
  subject        TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  settings       INTEGER NOT NULL DEFAULT 0,
  records        INTEGER NOT NULL DEFAULT 0,
  files          INTEGER NOT NULL DEFAULT 0,
  revision_bytes INTEGER NOT NULL DEFAULT 0,
  quota_bytes    INTEGER NOT NULL DEFAULT 0,
  tier_id        TEXT,
  platform       TEXT,
  last_active_at INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product, subject)
);
CREATE INDEX IF NOT EXISTS idx_sync_directory_active ON sync_directory(product, last_active_at);
CREATE TABLE IF NOT EXISTS sync_product_usage (
  product        TEXT PRIMARY KEY,
  bytes          INTEGER NOT NULL DEFAULT 0,
  users          INTEGER NOT NULL DEFAULT 0,
  settings_bytes INTEGER NOT NULL DEFAULT 0,
  record_bytes   INTEGER NOT NULL DEFAULT 0,
  file_bytes     INTEGER NOT NULL DEFAULT 0,
  revision_bytes INTEGER NOT NULL DEFAULT 0,
  breakdown_json TEXT NOT NULL DEFAULT '{}',
  computed_at    INTEGER NOT NULL DEFAULT 0
);
