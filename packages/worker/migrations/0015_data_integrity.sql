-- Polaris Key — data-layer integrity constraints and the indexes the hot paths actually need.
--
-- Every statement is `IF NOT EXISTS`, so this file is idempotent and safe to replay (R11-04).
--
-- Why triggers and not `CHECK`: SQLite has no `ALTER TABLE ... ADD CONSTRAINT`. Adding a real
-- CHECK to an existing table means a full rebuild (create/copy/drop/rename) of six tables —
-- licenses, devices, keys_index, product_keys, products, tiers — with every index and foreign
-- key reconstructed, executed on D1 without a wrapping transaction. A BEFORE INSERT/UPDATE
-- trigger that RAISE(ABORT)s is enforced by the same engine at the same point in statement
-- processing and is additive, so it carries none of that risk. The vocabularies below are the
-- ones the code actually writes; `0008_portal.sql` and `0010_fingerprint.sql` already declare
-- the equivalent CHECKs inline on the tables they created.

-- ── R11-02 / R3-02: seat consumption ─────────────────────────────────────────
-- One device per (license, seat ordinal). A concurrent claimant for the same ordinal loses at
-- the DATABASE, exactly as idx_licenses_enroll_hwid already does for enrolment — which is what
-- makes claimDeviceSeat() in repo.ts atomic instead of check-then-act.
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_seat
  ON devices(product, license_id, seat_no)
  WHERE status = 'authorized' AND seat_no IS NOT NULL;

-- R11-10: countActiveDevices() previously took idx_devices_status and filtered license_id row
-- by row, so every activation scanned the product's entire authorized device set.
CREATE INDEX IF NOT EXISTS idx_devices_license_status
  ON devices(product, license_id, status);

-- ── R11-08 / R10-13: the portal's per-request license sweeps ─────────────────
-- `licenses` had NO index touching `email` at all, so syncAccountLicenseLinks() ran a full
-- SCAN of every tenant's licenses once per verified email and once per identity, on every
-- authenticated portal request. An expression index makes `lower(email) = ?` a SEARCH.
-- Deliberately NOT partial: SQLite can prove `sub = ?` implies `sub IS NOT NULL` (so the index
-- below may be partial) but cannot prove the same for `lower(email) = ?`, and a partial index
-- whose condition it cannot prove is an index it will not use.
CREATE INDEX IF NOT EXISTS idx_licenses_email_lower ON licenses(lower(email));

-- idx_licenses_sub is (product, sub); a bare `sub = ?` cannot use it because `product` leads.
CREATE INDEX IF NOT EXISTS idx_licenses_sub_global
  ON licenses(sub)
  WHERE sub IS NOT NULL;

-- ── R11-05 / R11-12 / R5-10: download tokens ────────────────────────────────
-- PRIMARY KEY (product, token_hash) means a bare token_hash lookup is BOTH unindexed (a full
-- scan on an unauthenticated, unrate-limited endpoint) and ambiguous (two products may hold
-- the same hash and db.first picks arbitrarily). A globally unique index is the correct shape:
-- the hash is a 256-bit secret, so uniqueness across products is a real invariant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_download_tokens_hash
  ON release_download_tokens(token_hash);

-- ── R11-09 / R12-10: retention ──────────────────────────────────────────────
-- portal_audit had no index supporting a time-range delete, so no retention job could exist.
CREATE INDEX IF NOT EXISTS idx_portal_audit_at ON portal_audit(at);

-- ── R11-07 part A: status / origin vocabularies ─────────────────────────────
-- Every one of these previously accepted arbitrary text. A typo ('aktive', 'ACTIVE',
-- 'authorised') inserts cleanly and then fails closed at read time in a way no handler can
-- repair, because no code path matches the value.

CREATE TRIGGER IF NOT EXISTS trg_products_status_ins
BEFORE INSERT ON products
WHEN NEW.status IS NOT NULL AND NEW.status NOT IN ('active', 'disabled', 'deleted')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: products.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_products_status_upd
BEFORE UPDATE OF status ON products
WHEN NEW.status IS NOT NULL AND NEW.status NOT IN ('active', 'disabled', 'deleted')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: products.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_status_ins
BEFORE INSERT ON licenses
WHEN NEW.status NOT IN ('active', 'disabled')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_status_upd
BEFORE UPDATE OF status ON licenses
WHEN NEW.status NOT IN ('active', 'disabled')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_origin_ins
BEFORE INSERT ON licenses
WHEN NEW.origin IS NOT NULL AND NEW.origin NOT IN ('admin', 'oidc', 'enroll')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.origin'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_origin_upd
BEFORE UPDATE OF origin ON licenses
WHEN NEW.origin IS NOT NULL AND NEW.origin NOT IN ('admin', 'oidc', 'enroll')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.origin'); END;

CREATE TRIGGER IF NOT EXISTS trg_keys_index_status_ins
BEFORE INSERT ON keys_index
WHEN NEW.status NOT IN ('active', 'revoked')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: keys_index.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_keys_index_status_upd
BEFORE UPDATE OF status ON keys_index
WHEN NEW.status NOT IN ('active', 'revoked')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: keys_index.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_devices_status_ins
BEFORE INSERT ON devices
WHEN NEW.status NOT IN ('authorized', 'deauthorized')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: devices.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_devices_status_upd
BEFORE UPDATE OF status ON devices
WHEN NEW.status NOT IN ('authorized', 'deauthorized')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: devices.status'); END;

-- 0003_keyvault.sql:15 documents `active | retired`; four values are written in practice.
-- retire = stop signing, keep verifying; revoke = stop both. Both spellings are correct and
-- both are in the vocabulary (R11 verified server-side revocation works — do not "fix" it).
CREATE TRIGGER IF NOT EXISTS trg_product_keys_status_ins
BEFORE INSERT ON product_keys
WHEN NEW.status NOT IN ('active', 'staged', 'retired', 'revoked')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: product_keys.status'); END;

CREATE TRIGGER IF NOT EXISTS trg_product_keys_status_upd
BEFORE UPDATE OF status ON product_keys
WHEN NEW.status NOT IN ('active', 'staged', 'retired', 'revoked')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: product_keys.status'); END;

-- ── R11-02 part 2: a non-positive device limit must not mean "unlimited" ─────
-- licenseCore.ts gates the seat check on `limit > 0`, so a 0 or negative limit disabled seat
-- enforcement entirely for every license on the tier. NULL still means "inherit the product
-- default"; a stored number must now be a real seat count.
CREATE TRIGGER IF NOT EXISTS trg_tiers_device_limit_ins
BEFORE INSERT ON tiers
WHEN NEW.policy_device_limit IS NOT NULL AND NEW.policy_device_limit <= 0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: tiers.policy_device_limit > 0'); END;

CREATE TRIGGER IF NOT EXISTS trg_tiers_device_limit_upd
BEFORE UPDATE OF policy_device_limit ON tiers
WHEN NEW.policy_device_limit IS NOT NULL AND NEW.policy_device_limit <= 0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: tiers.policy_device_limit > 0'); END;

CREATE TRIGGER IF NOT EXISTS trg_products_device_limit_ins
BEFORE INSERT ON products
WHEN NEW.default_device_limit IS NOT NULL AND NEW.default_device_limit <= 0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: products.default_device_limit > 0'); END;

CREATE TRIGGER IF NOT EXISTS trg_products_device_limit_upd
BEFORE UPDATE OF default_device_limit ON products
WHEN NEW.default_device_limit IS NOT NULL AND NEW.default_device_limit <= 0
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: products.default_device_limit > 0'); END;
