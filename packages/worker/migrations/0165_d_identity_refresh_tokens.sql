-- I-21.2 (plans/I-20.md §3.3, V5 §12.13.7): issuer refresh tokens, one row per token, grouped in
-- families. Provisional number; the lead assigns the real one at merge.
--
--   token_hash         HMAC(KEY_HASH_PEPPER, token), hex: the token (`pkeyo_` + 43 characters) is
--                      never stored. With `product`, the key (R11-05: product first).
--   family_id          the family a code redemption opens; every rotation joins it.
--   product, client_id, account_id, scope, claims_json, auth_time   what the family was issued for.
--   family_started_at  when the family opened; it ends 90 days later however it is used.
--   created_at         when this token was issued.
--   last_used_at       when it was last used (set at issue); it ends 30 days later.
--   spent_at           set when it was rotated; a spent token presented again revokes the family.
--   replaced_by        the token_hash that replaced it.
--   revoked_at         set on every row of a revoked family.
--   code_hash          on a family's first row: HMAC of the authorization code that opened it, so a code
--                      presented again after redemption revokes the family (RFC 6749 §4.1.2).
--   redirect_uri       the registered redirect URI the family was issued for; each use re-checks it.
--
-- A subject store (`identity.refreshTokens`, registered by I-21.15). Owned by identity. No foreign
-- keys. Expand-only. Rollback: scripts/rollback/0165_d_identity_refresh_tokens.down.sql.
CREATE TABLE IF NOT EXISTS identity_refresh_tokens (
  token_hash        TEXT NOT NULL,
  family_id         TEXT NOT NULL,
  product           TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  account_id        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  claims_json       TEXT NOT NULL DEFAULT '[]',
  auth_time         INTEGER NOT NULL,
  family_started_at INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  spent_at          INTEGER,
  replaced_by       TEXT,
  revoked_at        INTEGER,
  code_hash         TEXT,
  redirect_uri      TEXT,
  PRIMARY KEY (product, token_hash)
);
CREATE INDEX IF NOT EXISTS identity_refresh_tokens_code
  ON identity_refresh_tokens (product, code_hash);
CREATE INDEX IF NOT EXISTS identity_refresh_tokens_family
  ON identity_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS identity_refresh_tokens_owner
  ON identity_refresh_tokens (account_id, client_id);
CREATE INDEX IF NOT EXISTS identity_refresh_tokens_client
  ON identity_refresh_tokens (client_id);
