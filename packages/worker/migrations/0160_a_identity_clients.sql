-- I-21.2 (plans/I-20.md §6, V5 §12.13.2): the registered clients of a product's issuer and their
-- secrets. Provisional number; the lead assigns the real one at merge.
--
-- identity_clients: one row per (product, key). `client_id` is `cl_` + 22 base64url characters,
-- minted once and never reused (the manifest key may be reused after a delete, the id never is).
--   key            the manifest key; unique within the product.
--   origin         `console` or `manifest`: who owns the row's declared members. Manifest ingest
--                  upserts and disables only `manifest` rows.
--   type           web (confidential), spa or native (public).
--   *_json         JSON arrays of strings (redirect URIs, post-logout URIs, scopes, required claims).
--   developer_name null means the product's developer; another one is a partner client.
--   icon_url       the client's own same-origin icon, or null.
--   status         `active` or `disabled`; a disabled client is unknown to every issuer route.
--
-- identity_client_secrets: a `web` client's secrets, at most two live. `secret_hash` is
-- HMAC(KEY_HASH_PEPPER, secret): the secret is shown once and never stored. `last4` is the last
-- four characters, for the console. A revoked row stays for the audit trail until the client goes.
--
-- Both tables are Identity's (TABLE_OWNERS). No foreign keys, no cascades (R11-01): the repository
-- deletes a client's secrets and grants with it. Expand-only: a Worker built before this migration
-- never names them. Rollback: scripts/rollback/0160_a_identity_clients.down.sql.
CREATE TABLE IF NOT EXISTS identity_clients (
  client_id                   TEXT NOT NULL PRIMARY KEY,
  product                     TEXT NOT NULL,
  key                         TEXT NOT NULL,
  origin                      TEXT NOT NULL DEFAULT 'console' CHECK (origin IN ('console', 'manifest')),
  name                        TEXT NOT NULL,
  developer_name              TEXT,
  type                        TEXT NOT NULL CHECK (type IN ('web', 'spa', 'native')),
  redirect_uris_json          TEXT NOT NULL,
  post_logout_redirect_uris_json TEXT NOT NULL DEFAULT '[]',
  scopes_json                 TEXT NOT NULL,
  claims_required_json        TEXT NOT NULL DEFAULT '[]',
  icon_url                    TEXT,
  status                      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL,
  UNIQUE (product, key)
);

CREATE TABLE IF NOT EXISTS identity_client_secrets (
  id           TEXT NOT NULL PRIMARY KEY,
  client_id    TEXT NOT NULL,
  product      TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  last4        TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX IF NOT EXISTS identity_client_secrets_client
  ON identity_client_secrets (client_id, revoked_at);
CREATE INDEX IF NOT EXISTS identity_client_secrets_hash
  ON identity_client_secrets (secret_hash);
