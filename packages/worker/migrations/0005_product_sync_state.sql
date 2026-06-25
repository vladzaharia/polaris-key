-- Product manifest/release sync status.
-- One row per product records the last repo-driven sync attempt so operators can see
-- webhook/manual state, changed paths, applied sections, and manifest errors in admin.

CREATE TABLE IF NOT EXISTS product_sync_state (
  product            TEXT PRIMARY KEY REFERENCES products(slug),
  source             TEXT NOT NULL, -- manual | webhook
  status             TEXT NOT NULL, -- ok | error | ignored
  last_checked_at    INTEGER NOT NULL,
  last_synced_at     INTEGER,
  commit_sha         TEXT,
  changed_paths_json TEXT,
  updated_json       TEXT,
  errors_json        TEXT,
  message            TEXT
);

