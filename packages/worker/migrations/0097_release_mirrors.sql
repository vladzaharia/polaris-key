-- HA-08 (notes/S-20 §4.3, §6.3 "Mirror a release file", §6.8): release-file mirroring.
--
-- Every app-release file whose only byte locations are `github` or `external` gets a verified
-- copy in the blob store and an `r2` location appended to `release_artifacts.locations_json`, so
-- the byte routes serve our bytes first (`serveArtifact` ranks `r2` ahead of `github`). The copy
-- itself is a hosted asset (`hosted_assets`, slot `release-file:<sha256>`, written by Core's
-- `ingest`); the location is held by a `blob_refs` row of kind `release-artifact` whose `ref_id`
-- is `<release_id>/<artifact_id>`. This table is only the per-file JOB: whether a copy is owed,
-- when it may next be tried, and why the last try failed (`services/release/mirror.ts`).
--
-- One row per release file that was ever queued:
--
--   status           queued (a message is on `pkey-assets-<env>`) | ready (the r2 location is
--                    appended) | failed (the last try was refused; `error` says why)
--   source_ref       what the last try read: `github:<asset id>` or the external https URL
--   sha256           the verified copy's SHA-256 once ready (GitHub's `digest` and the
--                    descriptor's `sha256`, which must agree)
--   error            the last failure's reason code: an ingest reason (`sha256-mismatch`,
--                    `size-mismatch`, `too-large`, `status:<n>`, `timeout`, `network`, …) or one
--                    of the mirror's own (`no-digest`, `digest-mismatch`, `no-source`,
--                    `no-access`, `github:<n>`)
--   attempts         failed tries since the last good one (exponential back-off, 15 minutes
--                    doubling to a 24-hour cap, as HA-05's pulls)
--   next_attempt_at  when the file may be queued again (epoch seconds); NULL means now. Set when
--                    a message is sent too, so two syncs in quick succession queue it once.
--   tried_at         when the consumer last settled the file (ready or failed)
--
-- Whether a file is OWED is read from `release_artifacts` (a github or external location and no
-- r2 one), never from this table: a descriptor that rewrites `locations_json` makes the file owed
-- again, and the next sync queues it.
--
-- Release owns the table (TABLE_OWNERS). The foreign key cascades, so a release file's deletion
-- (feed retention's prune of a package version, which is never mirrored) takes its row along.
-- Expand-only: nothing older reads it, and every statement is IF NOT EXISTS, so a replay
-- converges. Rollback: `DROP TABLE release_mirrors;` (the copies and their refs stay valid).
CREATE TABLE IF NOT EXISTS release_mirrors (
  product          TEXT NOT NULL,
  release_id       TEXT NOT NULL,
  artifact_id      TEXT NOT NULL,
  status           TEXT NOT NULL,
  source_ref       TEXT,
  sha256           TEXT,
  error            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  tried_at         INTEGER,
  modified_at      INTEGER NOT NULL,
  PRIMARY KEY (product, release_id, artifact_id),
  FOREIGN KEY (product, release_id, artifact_id) REFERENCES release_artifacts ON DELETE CASCADE,
  CHECK (status IN ('queued', 'ready', 'failed'))
);
