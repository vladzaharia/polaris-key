-- Polaris Key — initial multi-tenant schema.
-- Every table is product-scoped: `product` is column 1 of the primary key / indexes, so
-- a missing product predicate can never return another tenant's rows. Hot credential
-- lookups (token-hash -> device, key-hash -> license) live in KV, not here.
-- Times are epoch SECONDS. JSON payloads are stored as TEXT.

PRAGMA foreign_keys = ON;

-- The product registry: one row per tenant. Signing key material lives in product_keys.
CREATE TABLE IF NOT EXISTS products (
  slug                    TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  -- kid stamped into the JWS header; the private key is sealed in product_keys.
  signing_kid             TEXT NOT NULL,
  -- Raw 32-byte Ed25519 public key (base64url), exposed at /<product>/.well-known/jwks.json.
  signing_pub             TEXT,
  compat_min              TEXT NOT NULL DEFAULT '0.0.0',
  compat_max              TEXT NOT NULL DEFAULT '99.0.0',
  default_max_offline_days INTEGER NOT NULL DEFAULT 30,
  default_device_limit   INTEGER NOT NULL DEFAULT 5,
  admin_group             TEXT,
  branding_json           TEXT,
  created_at              INTEGER NOT NULL,
  modified_at             INTEGER NOT NULL
);

-- Data-driven config catalog, versioned per product. catalog_version == the signed doc's
-- schemaVersion. Exactly one row per product should be active.
CREATE TABLE IF NOT EXISTS product_schema (
  product         TEXT NOT NULL REFERENCES products(slug),
  catalog_version INTEGER NOT NULL,
  catalog_json    TEXT NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (product, catalog_version)
);

-- Shared managed-payload baselines (a tier attaches one).
CREATE TABLE IF NOT EXISTS profiles (
  product      TEXT NOT NULL REFERENCES products(slug),
  id           TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  payload_json TEXT NOT NULL,
  modified_by  TEXT,
  modified_at  INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);

-- A named plan: a profile bundle + policy (default expiry/device-limit).
CREATE TABLE IF NOT EXISTS tiers (
  product             TEXT NOT NULL REFERENCES products(slug),
  id                  TEXT NOT NULL,
  label               TEXT NOT NULL,
  profile_id          TEXT,
  policy_expiry_days  INTEGER,
  policy_device_limit INTEGER,
  modified_by         TEXT,
  modified_at         INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);

-- An account: status + identity + tier + per-license overrides.
CREATE TABLE IF NOT EXISTS licenses (
  product         TEXT NOT NULL REFERENCES products(slug),
  id              TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  sub             TEXT,
  name            TEXT,
  email           TEXT,
  groups_json     TEXT,
  tier_id         TEXT,
  activated_at     INTEGER NOT NULL,
  expires_at      INTEGER,
  max_offline_days INTEGER,
  overrides_json  TEXT,
  modified_by     TEXT,
  modified_at     INTEGER NOT NULL,
  PRIMARY KEY (product, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_sub ON licenses(product, sub) WHERE sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(product, status);

-- List source-of-truth for keys (the hot key-hash -> license lookup is in KV).
CREATE TABLE IF NOT EXISTS keys_index (
  product      TEXT NOT NULL REFERENCES products(slug),
  key_hash     TEXT NOT NULL,
  license_id   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  label        TEXT,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  last_used_at INTEGER,
  PRIMARY KEY (product, key_hash)
);
CREATE INDEX IF NOT EXISTS idx_keys_license ON keys_index(product, license_id);

-- Authorized installs. token_hash mirrors the KV token -> device record.
CREATE TABLE IF NOT EXISTS devices (
  product       TEXT NOT NULL REFERENCES products(slug),
  device_id    TEXT NOT NULL,
  customer_id   TEXT,
  license_id    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'authorized',  -- authorized | deauthorized
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ua            TEXT,
  label         TEXT,
  platform      TEXT,
  arch          TEXT,
  app_version   TEXT,
  sdk_name      TEXT,
  sdk_version   TEXT,
  overrides_json TEXT,
  reported_json TEXT,
  token_hash    TEXT,
  PRIMARY KEY (product, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_license ON devices(product, license_id);

-- Per-product release distribution config (GitHub App + channels + Sparkle).
CREATE TABLE IF NOT EXISTS release_config (
  product             TEXT PRIMARY KEY REFERENCES products(slug),
  gh_owner            TEXT,
  gh_repo             TEXT,
  gh_installation_id  INTEGER,
  channel_workflow    TEXT,
  beta_branch         TEXT NOT NULL DEFAULT 'main',
  manual_channels_json TEXT,
  binary_name         TEXT,
  install_template    TEXT,
  sparkle_ed25519_pub TEXT,
  summary_marker      TEXT NOT NULL DEFAULT 'pkey:summary'
);

-- Per-product OIDC config (shared IdP, per-product client + group mapping).
CREATE TABLE IF NOT EXISTS oidc_config (
  product            TEXT PRIMARY KEY REFERENCES products(slug),
  issuer             TEXT,
  client_id          TEXT,
  client_secret_secret TEXT,           -- Worker secret name, not the value
  redirect_uris_json TEXT,
  group_role_map_json TEXT             -- group -> { role: admin|user, tier?: <tierId> }
);

-- Generic provisioning hooks: an OIDC claim -> entitlement + secret value template.
CREATE TABLE IF NOT EXISTS provisioning_config (
  product               TEXT NOT NULL REFERENCES products(slug),
  claim                 TEXT NOT NULL,
  entitlement_key       TEXT,
  entitlement_value_json TEXT,
  secret_key            TEXT,
  secret_url_template   TEXT,
  allowed_hosts_json    TEXT,
  PRIMARY KEY (product, claim)
);

-- Generic edge-token minting recipes (Apple MusicKit is the first instance).
CREATE TABLE IF NOT EXISTS edge_mint_config (
  product             TEXT NOT NULL REFERENCES products(slug),
  id                  TEXT NOT NULL,
  alg                 TEXT NOT NULL,
  signing_key_secret  TEXT NOT NULL,    -- product_secrets name
  kid                 TEXT,
  claims_template_json TEXT,
  ttl_seconds         INTEGER NOT NULL DEFAULT 3600,
  auth_page_template  TEXT,
  PRIMARY KEY (product, id)
);

-- OIDC subject -> license (idempotent re-sign-in).
CREATE TABLE IF NOT EXISTS identity (
  product    TEXT NOT NULL REFERENCES products(slug),
  sub        TEXT NOT NULL,
  license_id TEXT NOT NULL,
  PRIMARY KEY (product, sub)
);

-- Append-only audit log. Keyset pagination on (at DESC, id DESC).
CREATE TABLE IF NOT EXISTS audit (
  product      TEXT NOT NULL REFERENCES products(slug),
  id           TEXT NOT NULL,
  at           INTEGER NOT NULL,
  actor_sub    TEXT,
  actor_name   TEXT,
  actor_email  TEXT,
  action       TEXT NOT NULL,
  target_kind  TEXT,
  target_id    TEXT,
  parent_id    TEXT,
  summary      TEXT,
  PRIMARY KEY (product, id)
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit(product, at DESC, id DESC);
