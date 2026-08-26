-- Polaris Key — auto-issued ("always free") licenses.
--
-- A product can opt into issuing a license with no key and no sign-in, so software that mainly
-- wants signed settings distribution doesn't have to gate every install behind a credential.
-- Additive only, following the existing migration conventions.

PRAGMA foreign_keys = ON;

-- { enabled, tierId, mode: "anonymous" | "oidcDefault" | "both", rateLimitPerHour }
ALTER TABLE products ADD COLUMN auto_issue_json TEXT;

-- 'manifest' => .pkey/product owns this policy and resync reapplies it.
-- 'admin'    => an operator edited it live; resync must leave it alone.
ALTER TABLE products ADD COLUMN auto_issue_source TEXT NOT NULL DEFAULT 'manifest';

-- How this license came into existence. Existing rows are admin-minted by definition.
--   admin  — an operator created it (and got its first key)
--   oidc   — minted on OIDC sign-in
--   enroll — auto-issued, keyless, bound to a machine
ALTER TABLE licenses ADD COLUMN origin TEXT NOT NULL DEFAULT 'admin';

-- The hwid an enrolled license is bound to. NULL for every other origin.
ALTER TABLE licenses ADD COLUMN enroll_hwid TEXT;

-- One free license per machine per product, enforced by the DATABASE rather than by
-- application logic — the same partial-unique pattern idx_licenses_sub already uses for OIDC
-- subjects. A race between two concurrent enrolments therefore cannot mint two licenses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_enroll_hwid
  ON licenses(product, enroll_hwid)
  WHERE enroll_hwid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_licenses_origin ON licenses(product, origin);
