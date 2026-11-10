-- I-21.3 (plans/I-20.md §3.4, V5 §12.13.5): the issuer key ring, one RSA-2048 key per row and a
-- ring per product. Provisional number; the lead assigns the real one at merge.
--
--   kid           the RFC 7638 SHA-256 thumbprint of the public key, base64url.
--   state         `next` (published, signs nothing), `active` (signs; the only one that does) or
--                 `retired` (still in /jwks, signs nothing). A key that leaves the set is deleted,
--                 sealed private half and all.
--   sealed        the PKCS#8 private key under the key vault's `issuer-signing-key` kind, with the
--                 additional data `pkey:v2:<product>:issuer-signing-key:<kid>`. Never selected by
--                 the JWKS reader, never in a response, a log or an audit row.
--   n, e          the public key members, base64url (what /jwks serves).
--   published_at  when the key entered /jwks; a `next` key activates at least 7 days later.
--   activated_at  when it began to sign (null while `next`); a key rotates 90 days after this.
--   retired_at    when it stopped signing; it leaves the set 30 days later.
--
-- The partial unique index is the backstop for "at most one active key per product", and likewise
-- for `next`; the repository's inserts are conditional and do not rely on it. Owned by identity
-- (TABLE_OWNERS). Expand-only. Rollback: scripts/rollback/0161_b_identity_issuer_keys.down.sql.
CREATE TABLE IF NOT EXISTS identity_issuer_keys (
  product      TEXT NOT NULL,
  kid          TEXT NOT NULL,
  state        TEXT NOT NULL CHECK (state IN ('next', 'active', 'retired')),
  sealed       TEXT NOT NULL,
  n            TEXT NOT NULL,
  e            TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER NOT NULL,
  activated_at INTEGER,
  retired_at   INTEGER,
  PRIMARY KEY (product, kid)
);
CREATE UNIQUE INDEX IF NOT EXISTS identity_issuer_keys_one_active
  ON identity_issuer_keys (product) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS identity_issuer_keys_one_next
  ON identity_issuer_keys (product) WHERE state = 'next';
