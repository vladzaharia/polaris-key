-- P2b-03 — availability, submissions and the key inventory (README §3.8 "Data model").
--
-- All three tables are Distribution's (`TABLE_OWNERS.distribution` in the docs generator),
-- written only by `services/distribution/availability.ts`: the CI report route
-- (`POST /<p>/distribution/report`, a `pkeyci_` token with `distribution:report`) and the
-- console's key inventory. Store connectors (P5-02 to P5-04) will write the first two as well.
-- No ingest writes any of them.
--
-- The vocabularies (`state`, `purpose`, `source`) are enforced in code, not by CHECK: P5's
-- connectors map store states onto them and may grow them, and a CHECK change is a table rebuild
-- in SQLite. Every reader normalises a value outside today's vocabulary to a NON-live one
-- (fail closed: a garbage availability never reads as `live`).
--
-- `dist_availability` — is release R (build B) available on outlet O, and since when?
--
--   - `build_id` is '' when the report is per release (a store that ships one binary per
--     release, or a report that does not know the build).
--   - `state` is pending | processing | in-review | approved | live | rejected | removed. A report
--     may move it backwards (a rejection after review); the row keeps the CURRENT state and the
--     audit log keeps every change.
--   - `since` is when the row entered `state` (epoch seconds).
--   - `platform_ref_json` holds store-assigned ids (an ASC build id, a Play version code, a Steam
--     depot manifest). They arrive after signing, so they live here and never in Release.
--   - `source` is who last wrote the row: `ci`, `admin`, or a connector kind (`asc`, `play`,
--     `ms-store`) once P5 lands. Nothing stops a connector overwriting a CI report; P5 decides
--     precedence per outlet.
--   - Self-hosted outlets need no row: the `delivery` hook derives `live` from Release's truth.
--     A stored row for (release, build, outlet) wins over the derived answer.
--
-- `dist_submissions` — where release R stands in outlet O's review lifecycle.
--
--   - `state` is prepared | submitted | in-review | approved | rejected |
--     pending-developer-release | released | cancelled.
--   - `submitted_at` is set when the row enters `submitted`, `reviewed_at` when it enters
--     `approved` or `rejected`.
--
-- `dist_keys` — the per-product signing-key inventory, OPERATOR-owned. Its fingerprints are what
-- players and AppVerifier check a download against, so it is the independent control against a
-- compromised pipeline.
--
--   - `fingerprint_sha256` is lower-case hex SHA-256 of the certificate (or of the raw public key
--     for Ed25519), validated on write.
--   - `source = 'admin'` rows are the inventory. `source = 'ci'` rows are OBSERVATIONS: a CI key
--     report whose fingerprint matches no inventory entry for its purpose is stored as its own
--     row, flagged, and never changes an entry. An operator adopts one (PUT, which makes it
--     `admin`) or dismisses it (DELETE).
--   - `observed_json` is the last CI observation of that fingerprint (who, when, which outlet).
--     It is the only column a CI report ever writes on an operator row.
--   - `registered_at` is the operator's record that the key is registered for Android developer
--     verification (NULL = not registered). Registration itself happens in Google's console.
CREATE TABLE IF NOT EXISTS dist_availability (
  product           TEXT NOT NULL REFERENCES products(slug),
  release_id        TEXT NOT NULL,
  build_id          TEXT NOT NULL DEFAULT '',
  outlet_id         TEXT NOT NULL,
  transport         TEXT NOT NULL,
  state             TEXT NOT NULL,
  since             INTEGER NOT NULL,
  platform_ref_json TEXT,
  detail_json       TEXT,
  source            TEXT NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (product, release_id, build_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS dist_submissions (
  product      TEXT NOT NULL REFERENCES products(slug),
  release_id   TEXT NOT NULL,
  outlet_id    TEXT NOT NULL,
  state        TEXT NOT NULL,
  submitted_at INTEGER,
  reviewed_at  INTEGER,
  detail_json  TEXT,
  source       TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (product, release_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS dist_keys (
  product            TEXT NOT NULL REFERENCES products(slug),
  purpose            TEXT NOT NULL,
  fingerprint_sha256 TEXT NOT NULL,
  outlet_id          TEXT,
  notes              TEXT,
  registered_at      INTEGER,
  source             TEXT NOT NULL,
  observed_json      TEXT,
  created_at         INTEGER NOT NULL,
  modified_at        INTEGER NOT NULL,
  PRIMARY KEY (product, purpose, fingerprint_sha256)
);
