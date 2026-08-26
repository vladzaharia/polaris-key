-- R11-13 / R12-10 — drop the two dead PII-bearing tables.
--
-- `customers` (0007_backend_contracts.sql:6-31) carries sub, name, email, groups_json and
-- metadata_json behind four indexes and a status CHECK, and has NO reader and NO writer
-- anywhere in src/. `identity` (0001_init.sql:172-178) likewise — its role was superseded by
-- licenses.sub + idx_licenses_sub. An unused table that is still reachable from the D1 console
-- is a latent PII store with no owner, no erasure path and no retention story.
--
-- `release_download_tokens.customer_id` is the only live reference to `customers`; it is
-- written as a literal NULL at portal/repo.ts and read nowhere, so the column and its foreign
-- key go with the table. SQLite cannot drop a column that participates in a foreign key, so
-- the table is rebuilt. The rebuild is idempotent: on a replay the `_v2` table is recreated
-- empty, the explicit column list still resolves against the already-migrated table, and the
-- copy/drop/rename runs again to the same end state.

CREATE TABLE IF NOT EXISTS release_download_tokens_v2 (
  product      TEXT NOT NULL REFERENCES products(slug),
  token_hash   TEXT NOT NULL,
  release_id   TEXT NOT NULL,
  artifact_id  TEXT,
  device_id    TEXT,
  scope_json   TEXT,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, token_hash),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id),
  FOREIGN KEY (product, release_id, artifact_id)
    REFERENCES release_artifacts(product, release_id, artifact_id),
  FOREIGN KEY (product, device_id) REFERENCES devices(product, device_id)
);

INSERT OR IGNORE INTO release_download_tokens_v2
  (product, token_hash, release_id, artifact_id, device_id, scope_json,
   expires_at, used_at, created_at)
SELECT product, token_hash, release_id, artifact_id, device_id, scope_json,
       expires_at, used_at, created_at
  FROM release_download_tokens;

DROP TABLE release_download_tokens;

ALTER TABLE release_download_tokens_v2 RENAME TO release_download_tokens;

-- The rebuild dropped the table's indexes with it; re-assert all three (0007 + 0015).
CREATE INDEX IF NOT EXISTS idx_release_download_tokens_expiry
  ON release_download_tokens(product, expires_at);
CREATE INDEX IF NOT EXISTS idx_release_download_tokens_artifact
  ON release_download_tokens(product, release_id, artifact_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_download_tokens_hash
  ON release_download_tokens(token_hash);

DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS identity;
