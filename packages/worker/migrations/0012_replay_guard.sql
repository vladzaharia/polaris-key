-- R11-04 — replay guard for the security-critical indexes.
--
-- `wrangler d1 migrations apply` records a migration in `d1_migrations` only when the WHOLE
-- file succeeded, and SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. So a run that
-- dies part way through a multi-statement migration is replayed from statement 1, fails again
-- on the duplicate column, and NEVER reaches the statements that follow it. In 0011 those
-- trailing statements are the two indexes below — and `idx_licenses_enroll_hwid` is the DB
-- guard the keyless free-license flow relies on ("one free license per machine, enforced by
-- the DATABASE rather than by application logic", 0011_auto_issue.sql:26-27). Without it
-- `getLicenseByEnrollHwid` is a pure check-then-act and a machine can mint unlimited licenses.
--
-- Every statement in this file is `IF NOT EXISTS`, so the file is fully idempotent: it is a
-- no-op on a healthy database and a repair on a half-applied one. Security-critical index
-- creation lives here, in its own file, so it can never be stranded behind a failed ALTER.

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_enroll_hwid
  ON licenses(product, enroll_hwid)
  WHERE enroll_hwid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_licenses_origin ON licenses(product, origin);

CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_sub
  ON licenses(product, sub)
  WHERE sub IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_keys_one_active
  ON product_keys(product)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_product_keys_verify
  ON product_keys(product, status, created_at);
