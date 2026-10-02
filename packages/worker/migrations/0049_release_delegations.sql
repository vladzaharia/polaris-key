-- P4-19 — content-key delegation (plans/P4-19.md §6.1). Two CREATE TABLEs and two partial unique
-- indexes, every statement `IF NOT EXISTS` and no ALTER, so a replay is a no-op.
--
-- `release_delegations` — Release's (`TABLE_OWNERS.release`). One row per CI-signed
-- `kind: delegation` release record (`pkey-release+jws`, signed by a declared release key, never
-- a product or content key) verbatim in `jws`: a content key (`public_key`, raw base64url) may
-- sign tree-layout pack records of the data-only `types_json` under the pack-id scope
-- `deliverable_id` (whole segments), with `issuedAt` inside [issued_at, expires_at]. `origin` is
-- `submit` for a delegation ingested by a delegation submit, `revocation` for one first seen
-- supplied alongside a revocation (stored already revoked). The revocation lives on the row
-- (`revocation_*`), because `release_revocations.target_release_id` is a NOT NULL foreign key to a
-- release and a delegation is none. A revocation is never cleared: a newer one (client-core's
-- `newerRevocation`) may only replace it. No path deletes a row.
--
-- The `seq` and key uniqueness apply to `submit` rows only (partial indexes): a supplied
-- delegation is often a second delegation of a stored key, or one whose `seq` a submit refused,
-- and it must still be storable as revoked. Ingest refuses a key any row already names, whatever
-- its origin (`delegation-key`).
CREATE TABLE IF NOT EXISTS release_delegations (
  product               TEXT NOT NULL REFERENCES products(slug),
  record_sha256         TEXT NOT NULL,
  deliverable_id        TEXT NOT NULL,
  seq                   INTEGER NOT NULL,
  version               TEXT NOT NULL,
  kid                   TEXT NOT NULL,
  jws                   TEXT NOT NULL,
  public_key            TEXT NOT NULL,
  types_json            TEXT NOT NULL,
  issued_at             INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL,
  ingested_at           INTEGER NOT NULL,
  origin                TEXT NOT NULL CHECK (origin IN ('submit', 'revocation')),
  revocation_sha256     TEXT,
  revocation_jws        TEXT,
  revocation_kid        TEXT,
  revocation_reason     TEXT,
  revocation_issued_at  INTEGER,
  PRIMARY KEY (product, record_sha256),
  CHECK ((revocation_sha256 IS NULL) = (revocation_jws IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS release_delegations_seq
  ON release_delegations(product, deliverable_id, seq) WHERE origin = 'submit';

CREATE UNIQUE INDEX IF NOT EXISTS release_delegations_key
  ON release_delegations(product, public_key) WHERE origin = 'submit';

-- `release_delegated_records` — Release's. One row per pack record a content key signed: the
-- record's hash and the delegation it was signed under (its kid's hex). Written in the pack
-- ingest's batch, guarded on the release row holding the record.
CREATE TABLE IF NOT EXISTS release_delegated_records (
  product            TEXT NOT NULL REFERENCES products(slug),
  record_sha256      TEXT NOT NULL,
  delegation_sha256  TEXT NOT NULL,
  PRIMARY KEY (product, record_sha256)
);
