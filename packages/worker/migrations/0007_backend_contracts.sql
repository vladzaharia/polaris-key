-- Backend contract scaffolding for first-class customers and release portal data.
--
-- R11-04: the two non-idempotent `ALTER TABLE ... ADD COLUMN`s that used to open this file now
-- close it, so a replay that dies on `duplicate column name: metadata_access` no longer strands
-- the ~130 lines of table and index creation that follow.

CREATE TABLE IF NOT EXISTS customers (
  product       TEXT NOT NULL REFERENCES products(slug),
  id            TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  external_id   TEXT,
  sub           TEXT,
  name          TEXT,
  email         TEXT,
  groups_json   TEXT,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL,
  modified_at   INTEGER NOT NULL,
  PRIMARY KEY (product, id),
  CHECK (status IN ('active', 'disabled', 'deleted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_external
  ON customers(product, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_sub
  ON customers(product, sub)
  WHERE sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_email
  ON customers(product, email)
  WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_status
  ON customers(product, status);

CREATE INDEX IF NOT EXISTS idx_devices_license_present
  ON devices(product, license_id)
  WHERE license_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_customer
  ON devices(product, customer_id)
  WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_token
  ON devices(product, token_hash)
  WHERE token_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_devices_status
  ON devices(product, status, last_seen DESC);

CREATE TABLE IF NOT EXISTS release_metadata (
  product         TEXT NOT NULL REFERENCES products(slug),
  release_id      TEXT NOT NULL,
  version         TEXT NOT NULL,
  title           TEXT,
  notes           TEXT,
  commit_sha      TEXT,
  source_url      TEXT,
  metadata_access TEXT NOT NULL DEFAULT 'public',
  artifacts_access TEXT NOT NULL DEFAULT 'public',
  published_at    INTEGER,
  metadata_json   TEXT,
  created_at      INTEGER NOT NULL,
  modified_at     INTEGER NOT NULL,
  PRIMARY KEY (product, release_id),
  CHECK (metadata_access IN ('public', 'authenticated', 'licensed')),
  CHECK (artifacts_access IN ('public', 'authenticated', 'licensed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_metadata_version
  ON release_metadata(product, version);
CREATE INDEX IF NOT EXISTS idx_release_metadata_published
  ON release_metadata(product, published_at DESC);

CREATE TABLE IF NOT EXISTS release_artifacts (
  product           TEXT NOT NULL REFERENCES products(slug),
  release_id        TEXT NOT NULL,
  artifact_id       TEXT NOT NULL,
  name              TEXT NOT NULL,
  kind              TEXT,
  platform          TEXT,
  arch              TEXT,
  content_type      TEXT,
  size_bytes        INTEGER,
  sha256            TEXT,
  source_url        TEXT,
  storage_key       TEXT,
  sparkle_signature TEXT,
  access            TEXT NOT NULL DEFAULT 'public',
  metadata_json     TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (product, release_id, artifact_id),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id),
  CHECK (access IN ('public', 'authenticated', 'licensed'))
);
CREATE INDEX IF NOT EXISTS idx_release_artifacts_lookup
  ON release_artifacts(product, name);
CREATE INDEX IF NOT EXISTS idx_release_artifacts_target
  ON release_artifacts(product, platform, arch);

CREATE TABLE IF NOT EXISTS release_channels (
  product      TEXT NOT NULL REFERENCES products(slug),
  channel      TEXT NOT NULL,
  release_id   TEXT,
  policy_json  TEXT,
  created_at   INTEGER NOT NULL,
  modified_at  INTEGER NOT NULL,
  PRIMARY KEY (product, channel),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id)
);

CREATE TABLE IF NOT EXISTS release_health (
  product      TEXT NOT NULL REFERENCES products(slug),
  subject_kind TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  status       TEXT NOT NULL,
  checked_at   INTEGER NOT NULL,
  details_json TEXT,
  PRIMARY KEY (product, subject_kind, subject_id),
  CHECK (subject_kind IN ('release', 'channel', 'artifact')),
  CHECK (status IN ('unknown', 'healthy', 'degraded', 'blocked'))
);
CREATE INDEX IF NOT EXISTS idx_release_health_status
  ON release_health(product, status, checked_at DESC);

CREATE TABLE IF NOT EXISTS release_download_tokens (
  product      TEXT NOT NULL REFERENCES products(slug),
  token_hash   TEXT NOT NULL,
  release_id   TEXT NOT NULL,
  artifact_id  TEXT,
  customer_id  TEXT,
  device_id    TEXT,
  scope_json   TEXT,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, token_hash),
  FOREIGN KEY (product, release_id) REFERENCES release_metadata(product, release_id),
  FOREIGN KEY (product, release_id, artifact_id)
    REFERENCES release_artifacts(product, release_id, artifact_id),
  FOREIGN KEY (product, customer_id) REFERENCES customers(product, id),
  FOREIGN KEY (product, device_id) REFERENCES devices(product, device_id)
);
CREATE INDEX IF NOT EXISTS idx_release_download_tokens_expiry
  ON release_download_tokens(product, expires_at);
CREATE INDEX IF NOT EXISTS idx_release_download_tokens_artifact
  ON release_download_tokens(product, release_id, artifact_id);

-- Non-idempotent tail (see the header): these must stay last in the file.
ALTER TABLE release_config ADD COLUMN metadata_access TEXT NOT NULL DEFAULT 'public';
ALTER TABLE release_config ADD COLUMN artifacts_access TEXT NOT NULL DEFAULT 'public';
