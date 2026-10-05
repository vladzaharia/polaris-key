-- I-05 (plans/I-04.md §6.1): the Polaris Key account, layer 1.
--
-- One global principal per person. `accounts` replaces `portal_accounts` (ids are KEPT, so
-- F-21's `registry_tokens.portal_account_id` and every signed portal cookie stay valid), sign-in
-- methods become `account_links`, and each (account, product) pair gets a stored random pairwise
-- subject, the only id a developer ever sees. The global account id never leaves the Worker's
-- Identity and Core code (S-16 §5.1).
--
-- Expand-only. The `portal_*` tables are NOT touched: a Worker rolled back to before I-05 reads
-- them unchanged, and `scripts/rollback/0068_accounts.down.sql` copies back what the new Worker
-- created. They are dropped by a contract-phase migration after I-17.
--
-- Every statement here is `IF NOT EXISTS`, so a replay converges (R11-04). The two `ADD COLUMN`s
-- this package needs live alone in 0068_b..d, and the backfill in 0068_e.
--
-- Owners (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): every table here is
-- Identity's; Core reads `account_product_subjects` and its aliases through
-- `src/core/accountSubjects.ts` only (rule 6), so Config and Cloud Sync never import Identity.

-- The person. `status` `deleted` is reserved for a deletion in progress; a finished deletion
-- removes the row and leaves an `account_tombstones` id. No row exists until a credential is
-- verified (S-16 §5.5).
CREATE TABLE IF NOT EXISTS accounts (
  id                        TEXT PRIMARY KEY,
  status                    TEXT NOT NULL DEFAULT 'active',
  primary_email             TEXT,
  primary_email_verified_at INTEGER,
  display_name              TEXT,
  avatar_key                TEXT,
  locale                    TEXT,
  details_source_json       TEXT,
  terms_json                TEXT,
  created_at                INTEGER NOT NULL,
  modified_at               INTEGER NOT NULL,
  last_sign_in_at           INTEGER,
  deleted_at                INTEGER,
  CHECK (status IN ('active', 'disabled', 'deleted'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_primary_email
  ON accounts(primary_email) WHERE primary_email IS NOT NULL;

-- A sign-in method: one verified (issuer, subject), attached to exactly one account. `issuer_key`
-- is the issuer URL for OIDC (I-01's key), `email` for an email method (subject = the normalised
-- address), a provider kind for the platform identities of I-06/I-14. `tenant_scope` is `''` for a
-- global subject and the developer team, game or deployment for a tenant-scoped one (Apple's
-- per-team id, Game Center's teamPlayerID, a PGS or EOS id): such a link is recognised only
-- inside products of that scope (S-16 §5.4 item 16).
CREATE TABLE IF NOT EXISTS account_links (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issuer_key     TEXT NOT NULL,
  tenant_scope   TEXT NOT NULL DEFAULT '',
  subject        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT,
  amr_json       TEXT,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER NOT NULL,
  UNIQUE (issuer_key, tenant_scope, subject)
);
CREATE INDEX IF NOT EXISTS idx_account_links_account ON account_links(account_id);
CREATE INDEX IF NOT EXISTS idx_account_links_email
  ON account_links(email) WHERE email IS NOT NULL;

-- The pairwise subject (`ps_` + 22 base64url characters): random and stored, not derived, so
-- "remove my data from <Product>" can end it and the next contact gets a fresh one. Created on
-- first contact, for every product, whatever its Identity toggle says.
CREATE TABLE IF NOT EXISTS account_product_subjects (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product),
  UNIQUE (product, subject)
);

-- After a merge (D21) the absorbed account's subject for a product resolves to the survivor's.
CREATE TABLE IF NOT EXISTS account_product_subject_aliases (
  product   TEXT NOT NULL,
  alias     TEXT NOT NULL,
  subject   TEXT NOT NULL,
  merged_at INTEGER NOT NULL,
  PRIMARY KEY (product, alias)
);
CREATE INDEX IF NOT EXISTS idx_account_subject_aliases_subject
  ON account_product_subject_aliases(product, subject);

-- An absorbed (merged) or deleted account id. A merge tombstone (`merged_into` set) redirects a
-- session of the absorbed account to the survivor for 30 days; a deletion tombstone (`merged_into`
-- NULL) carries only the id, so a restore from backup can re-apply the deletion. `email_hash` is
-- reserved for that restore path and is written NULL today.
CREATE TABLE IF NOT EXISTS account_tombstones (
  id          TEXT PRIMARY KEY,
  email_hash  TEXT,
  merged_into TEXT,
  deleted_at  INTEGER NOT NULL
);

-- The developer-facing pull feed of subject changes (plans/I-04.md §8 Q8): `subject.merged`
-- (payload: the alias) and `subject.deleted` (payload: the licence ids that were attached). Read
-- by the console Users page and an admin cursor (I-12). Carries pairwise subjects only.
CREATE TABLE IF NOT EXISTS subject_events (
  product      TEXT NOT NULL,
  id           TEXT NOT NULL,
  type         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  payload_json TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (product, id),
  CHECK (type IN ('subject.merged', 'subject.deleted'))
);
CREATE INDEX IF NOT EXISTS idx_subject_events_product_time
  ON subject_events(product, created_at, id);

-- Browser sessions on key.plrs.im (portal and login card), revocable and listable (S-16 §5.1).
-- Shape only: the portal's signed cookie stays the session until the login card (I-07) and
-- "sign out everywhere" (I-11) move onto this table.
CREATE TABLE IF NOT EXISTS account_sessions (
  id_hash      TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  user_agent   TEXT,
  amr_json     TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_sessions_account ON account_sessions(account_id);

-- The account's first "Continue to <App>" (D22) and the profile claims it consented to share
-- with that product (D19). Written by I-07/I-08.
CREATE TABLE IF NOT EXISTS account_product_grants (
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  product     TEXT NOT NULL,
  claims_json TEXT,
  granted_at  INTEGER NOT NULL,
  modified_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, product)
);

-- WebAuthn credentials on rp_id key.plrs.im (I-16). `user_handle` is random per account and never
-- the account id.
CREATE TABLE IF NOT EXISTS account_passkeys (
  credential_id   TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key      TEXT NOT NULL,
  sign_count      INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT,
  rp_id           TEXT NOT NULL,
  user_handle     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_account_passkeys_account ON account_passkeys(account_id);
