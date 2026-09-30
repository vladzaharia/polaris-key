-- P0-02 — release resolution: the version-index conflict and the R6-10 channel floor.
--
-- Idempotent statements only (DROP/CREATE ... IF [NOT] EXISTS), so this file replays cleanly.
-- The two `release_config` columns this package also adds are bare ALTERs and therefore sit in
-- their own files (0023_release_resolution_*.sql), one statement each, per the 0013/0014 rule.
--
-- 1. `idx_release_metadata_version` was UNIQUE (product, version) (0007), but the truth-store
--    upsert's conflict target is (product, release_id). Two tags that strip to one version —
--    `v1.2.0` and `1.2.0`, or a tag deleted and re-created with a different prefix — raised
--    `UNIQUE constraint failed` and rolled back the whole resync batch. Nothing in src/ looks a
--    release up by version, so the uniqueness bought nothing; the index stays for ordering.
DROP INDEX IF EXISTS idx_release_metadata_version;
CREATE INDEX IF NOT EXISTS idx_release_metadata_version
  ON release_metadata(product, version);

-- 2. R6-10. The highest version each moving channel (stable, beta without a channel workflow,
--    manual channels; never pinned, never pr-<n>) has resolved to during a truth-store sync.
--    Raised ONLY by the sync — the hot path never writes it. Live resolution that picks a
--    candidate below the floor looks the floor's release up by tag and serves it if it still
--    exists, else refuses with 404 rather than silently downgrading. An operator lowers or clears
--    a floor through POST /manage/api/products/<slug>/release/channels/<channel>/floor.
--
--    `release_id` is the floor release's tag. It has no foreign key to `release_metadata` on
--    purpose: the whole point of the row is to outlive a release that has disappeared. NULL when
--    an operator lowered the floor to a version the store has no row for (resolved by the pinned
--    `v<version>` / `<version>` lookup instead). A stop-gap: P2-03 folds these rows into
--    `release_channel_policy.min_supported`.
CREATE TABLE IF NOT EXISTS release_channel_floors (
  product    TEXT NOT NULL REFERENCES products(slug),
  channel    TEXT NOT NULL,
  version    TEXT NOT NULL,
  release_id TEXT,
  raised_at  INTEGER NOT NULL,
  lowered_by TEXT,
  lowered_at INTEGER,
  PRIMARY KEY (product, channel)
);
