-- P4-13 — revocation records (plans/P4-13.md §6.1, decision 18). One CREATE TABLE and no ALTER, so
-- a replay is a no-op (`IF NOT EXISTS`).
--
-- `release_revocations` — Release's (`TABLE_OWNERS.release`). One CURRENT revocation per revoked
-- pack record (`UNIQUE (product, target_sha256)`): the CI-signed `kind: revocation` release record
-- (`pkey-release+jws`, signed by a release key, never a product key) verbatim in `jws`, with the
-- target and the optional replacement it names. Written only by the CI submit route
-- (`services/release/packs/revocations.ts`). A later revocation of the same target with a newer
-- `issued_at` (ties: the higher record hash, client-core's `newerRevocation`) UPDATES the row in
-- place — record hash, JWS, kid, replacement, reason, `issued_at` — so it may add or change the
-- replacement; an older one is refused. No path ever DELETES a row: there is no un-revoke, and a
-- wrong revocation is fixed by a newer release. The same ingest batch yanks the target
-- (`release_yanks`, reason `revoked`), so even a Worker rolled back past P4-13 stops serving it.
--
-- Revocation records stay OUT of `release_records`: its `UNIQUE (product, deliverable_id, seq)`
-- would collide with the target's own row (a revocation carries the target's `seq`).
CREATE TABLE IF NOT EXISTS release_revocations (
  product                 TEXT NOT NULL REFERENCES products(slug),
  deliverable_id          TEXT NOT NULL,
  target_release_id       TEXT NOT NULL,
  target_sha256           TEXT NOT NULL,
  record_sha256           TEXT NOT NULL,
  kid                     TEXT NOT NULL,
  jws                     TEXT NOT NULL,
  replacement_release_id  TEXT,
  replacement_sha256      TEXT,
  reason                  TEXT NOT NULL,
  issued_at               INTEGER NOT NULL,
  ingested_at             INTEGER NOT NULL,
  PRIMARY KEY (product, record_sha256),
  UNIQUE (product, target_sha256),
  FOREIGN KEY (product, target_release_id) REFERENCES release_metadata(product, release_id),
  CHECK ((replacement_release_id IS NULL) = (replacement_sha256 IS NULL))
);
