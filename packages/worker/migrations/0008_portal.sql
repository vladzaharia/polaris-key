-- Universal end-user portal identity and module settings.
-- These tables are intentionally platform-global where the portal account is global, while
-- license links remain explicitly product-scoped.

CREATE TABLE IF NOT EXISTS portal_accounts (
  id            TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'active',
  display_name  TEXT,
  primary_email TEXT,
  created_at    INTEGER NOT NULL,
  modified_at   INTEGER NOT NULL,
  CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS portal_account_emails (
  email       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES portal_accounts(id),
  verified_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portal_account_emails_account
  ON portal_account_emails(account_id);

CREATE TABLE IF NOT EXISTS portal_account_identities (
  provider     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id),
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_portal_account_identities_account
  ON portal_account_identities(account_id);

CREATE TABLE IF NOT EXISTS portal_license_links (
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id),
  product      TEXT NOT NULL REFERENCES products(slug),
  license_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product, license_id),
  CHECK (source IN ('email', 'oidc', 'license-key', 'admin'))
);
CREATE INDEX IF NOT EXISTS idx_portal_license_links_license
  ON portal_license_links(product, license_id);

CREATE TABLE IF NOT EXISTS portal_product_settings (
  product                   TEXT PRIMARY KEY REFERENCES products(slug),
  portal_enabled            INTEGER NOT NULL DEFAULT 1,
  oidc_enabled              INTEGER NOT NULL DEFAULT 1,
  magic_enabled             INTEGER NOT NULL DEFAULT 1,
  license_key_claim_enabled INTEGER NOT NULL DEFAULT 1,
  releases_enabled          INTEGER NOT NULL DEFAULT 1,
  branding_json             TEXT,
  created_at                INTEGER NOT NULL,
  modified_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_audit (
  id          TEXT PRIMARY KEY,
  account_id  TEXT,
  at          INTEGER NOT NULL,
  action      TEXT NOT NULL,
  product     TEXT,
  target_kind TEXT,
  target_id   TEXT,
  summary     TEXT
);
CREATE INDEX IF NOT EXISTS idx_portal_audit_account_time
  ON portal_audit(account_id, at DESC, id DESC);
