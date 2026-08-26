-- R11-01 (residual 6) — declare ON DELETE on the foreign keys where it genuinely removes risk,
-- and add the index a product-scoped `portal_audit` retention sweep needs.
--
-- WHY ONLY THESE FOUR TABLES
--
-- The finding is that every FK in the schema references `products(slug)` and none declares
-- `ON DELETE`, so deletion is entirely application-level. SQLite has no
-- `ALTER TABLE ... ADD CONSTRAINT`, so each fix is a create/copy/drop/rename rebuild executed on
-- D1 with no wrapping transaction. That is cheap and safe for these four portal tables and
-- expensive and dangerous for the rest, so this migration does exactly the cheap half:
--
--   * `portal_account_emails`, `portal_account_identities`, `portal_license_links` are the three
--     child tables of `portal_accounts`. They are the reason `DELETE /api/me` exists, and they
--     are the tables whose orphans would be *PII* (`portal_account_emails.email` is the row's
--     PRIMARY KEY). CASCADE turns "erase an account" from a four-statement application ritual
--     that any future caller can get wrong into a property of the schema.
--   * `portal_product_settings` carries the same `products(slug)` edge as `portal_license_links`
--     and would otherwise be the one portal table left orphanable by a product delete.
--
-- All four are small, have no triggers, no incoming foreign keys, and at most one index each.
--
-- NOT rebuilt, deliberately: `licenses`, `devices`, `keys_index`, `product_keys`, `products`,
-- `tiers`, `audit`, `license_profiles`, `release_*`. Those carry the sixteen `RAISE(ABORT)`
-- triggers from 0015 (a `DROP TABLE` takes a table's triggers with it, so every rebuild would
-- have to reconstruct them), several carry composite FKs pointing at each other, and `licenses`
-- alone has five indexes including two partial-unique security invariants. A rebuild that
-- half-lands on D1 — no transaction — leaves a table with data and no constraints, which is
-- strictly worse than the missing `ON DELETE` it was fixing. They also do not need it: nothing
-- in `src/` hard-deletes a product (`deleteProduct` is a status flip plus a PII scrub), so the
-- parent row those FKs point at is never actually removed. See R11-data.md.

-- EACH REBUILD IS create / re-assert / copy / drop / rename, AND EVERY STEP IS REPLAY-SAFE.
--
-- D1 runs a migration file with no wrapping transaction, so R11-04's "a migration that fails
-- PART WAY leaves the schema half-applied" applies here too and has to be designed for rather
-- than hoped about. Two windows exist and both converge on a replay:
--
--   * dies BEFORE the drop — `_v2` exists and holds a copy; the replay's `CREATE ... IF NOT
--     EXISTS` is a no-op, `INSERT OR IGNORE` re-copies to the same rows (the primary key makes
--     it idempotent), and drop/rename finish the job.
--   * dies BETWEEN the drop and the rename — this is the sharp one: the original table is GONE
--     and `_v2` holds the only copy, so a naive replay would die on `SELECT … FROM <original>`
--     with `no such table` and stay stuck there forever. The `CREATE TABLE IF NOT EXISTS
--     <original>` before each copy is what closes it: the replay recreates the original EMPTY,
--     copies zero rows into a `_v2` that already holds them all, drops the empty shell and
--     renames `_v2` into place. No data is lost and the end state is identical.
--
-- On a first run against a healthy database every `IF NOT EXISTS` is a no-op and the sequence
-- degenerates to the ordinary copy/drop/rename.

-- ── portal_account_emails ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_account_emails_v2 (
  email       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Crash-window guard, not the live definition: a no-op unless a previous run died between
-- this table's DROP and the RENAME, in which case it is recreated EMPTY and dropped again below.
CREATE TABLE IF NOT EXISTS portal_account_emails (
  email       TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  verified_at INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

INSERT OR IGNORE INTO portal_account_emails_v2 (email, account_id, verified_at, created_at)
SELECT email, account_id, verified_at, created_at FROM portal_account_emails;

DROP TABLE portal_account_emails;

ALTER TABLE portal_account_emails_v2 RENAME TO portal_account_emails;

CREATE INDEX IF NOT EXISTS idx_portal_account_emails_account
  ON portal_account_emails(account_id);

-- ── portal_account_identities ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portal_account_identities_v2 (
  provider     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

-- Crash-window guard, not the live definition: a no-op unless a previous run died between
-- this table's DROP and the RENAME, in which case it is recreated EMPTY and dropped again below.
CREATE TABLE IF NOT EXISTS portal_account_identities (
  provider     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  email        TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);

INSERT OR IGNORE INTO portal_account_identities_v2
  (provider, subject, account_id, email, display_name, created_at, last_seen_at)
SELECT provider, subject, account_id, email, display_name, created_at, last_seen_at
  FROM portal_account_identities;

DROP TABLE portal_account_identities;

ALTER TABLE portal_account_identities_v2 RENAME TO portal_account_identities;

CREATE INDEX IF NOT EXISTS idx_portal_account_identities_account
  ON portal_account_identities(account_id);

-- ── portal_license_links ─────────────────────────────────────────────────────
-- Two edges, two answers. `account_id` CASCADEs because a link to an erased account is exactly
-- the orphan R11-09 describes. `product` CASCADEs because a link naming a product row that no
-- longer exists is unreadable by every query in `portal/repo.ts` (they all JOIN `products`) and
-- would silently reappear if the slug were ever re-registered.
--
-- There is still NO foreign key to `licenses(product, id)`. Adding one would abort this whole
-- migration on any deployment that already holds a link to a deleted license — `INSERT OR
-- IGNORE` does not skip foreign-key violations, only uniqueness/NOT NULL/CHECK ones — and the
-- listing JOIN already hides such rows. Reported, not fixed.
CREATE TABLE IF NOT EXISTS portal_license_links_v2 (
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  product      TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  license_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product, license_id),
  CHECK (source IN ('email', 'oidc', 'license-key', 'admin'))
);

-- Crash-window guard, not the live definition: a no-op unless a previous run died between
-- this table's DROP and the RENAME, in which case it is recreated EMPTY and dropped again below.
CREATE TABLE IF NOT EXISTS portal_license_links (
  account_id   TEXT NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  product      TEXT NOT NULL REFERENCES products(slug) ON DELETE CASCADE,
  license_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product, license_id),
  CHECK (source IN ('email', 'oidc', 'license-key', 'admin'))
);

INSERT OR IGNORE INTO portal_license_links_v2
  (account_id, product, license_id, source, created_at, last_seen_at)
SELECT account_id, product, license_id, source, created_at, last_seen_at
  FROM portal_license_links;

DROP TABLE portal_license_links;

ALTER TABLE portal_license_links_v2 RENAME TO portal_license_links;

CREATE INDEX IF NOT EXISTS idx_portal_license_links_license
  ON portal_license_links(product, license_id);

-- ── portal_product_settings ──────────────────────────────────────────────────
-- `auto_link_enabled` was added by 0013 and is carried through the rebuild; it stays last so the
-- column order matches what an already-migrated database has.
CREATE TABLE IF NOT EXISTS portal_product_settings_v2 (
  product                   TEXT PRIMARY KEY REFERENCES products(slug) ON DELETE CASCADE,
  portal_enabled            INTEGER NOT NULL DEFAULT 1,
  oidc_enabled              INTEGER NOT NULL DEFAULT 1,
  magic_enabled             INTEGER NOT NULL DEFAULT 1,
  license_key_claim_enabled INTEGER NOT NULL DEFAULT 1,
  releases_enabled          INTEGER NOT NULL DEFAULT 1,
  branding_json             TEXT,
  created_at                INTEGER NOT NULL,
  modified_at               INTEGER NOT NULL,
  auto_link_enabled         INTEGER
);

-- Crash-window guard, not the live definition: a no-op unless a previous run died between
-- this table's DROP and the RENAME, in which case it is recreated EMPTY and dropped again below.
CREATE TABLE IF NOT EXISTS portal_product_settings (
  product                   TEXT PRIMARY KEY REFERENCES products(slug) ON DELETE CASCADE,
  portal_enabled            INTEGER NOT NULL DEFAULT 1,
  oidc_enabled              INTEGER NOT NULL DEFAULT 1,
  magic_enabled             INTEGER NOT NULL DEFAULT 1,
  license_key_claim_enabled INTEGER NOT NULL DEFAULT 1,
  releases_enabled          INTEGER NOT NULL DEFAULT 1,
  branding_json             TEXT,
  created_at                INTEGER NOT NULL,
  modified_at               INTEGER NOT NULL,
  auto_link_enabled         INTEGER
);

INSERT OR IGNORE INTO portal_product_settings_v2
  (product, portal_enabled, oidc_enabled, magic_enabled, license_key_claim_enabled,
   releases_enabled, branding_json, created_at, modified_at, auto_link_enabled)
SELECT product, portal_enabled, oidc_enabled, magic_enabled, license_key_claim_enabled,
       releases_enabled, branding_json, created_at, modified_at, auto_link_enabled
  FROM portal_product_settings;

DROP TABLE portal_product_settings;

ALTER TABLE portal_product_settings_v2 RENAME TO portal_product_settings;

-- ── retention support ────────────────────────────────────────────────────────
-- 0015 added `idx_portal_audit_at` so a time-range delete became expressible at all. The
-- scheduled sweep prunes PER PRODUCT (one tenant's backlog must not decide another tenant's
-- batch), and `portal_audit.product` is nullable, so it needs `(product, at)` — which serves
-- both the `product = ?` passes and the single `product IS NULL` platform pass.
CREATE INDEX IF NOT EXISTS idx_portal_audit_product_at ON portal_audit(product, at);
