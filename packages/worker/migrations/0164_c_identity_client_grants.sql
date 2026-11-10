-- I-21.2 (plans/I-20.md §3.5, V5 §12.13.3): a client grant, the person's decision for one
-- registered client. Provisional number; the lead assigns the real one at merge.
--
--   (product, account_id, client_id)  the key (R11-05: product first).
--   claims_granted_json      the optional claims the person granted (`name`, `picture`, `email`).
--   claims_declined_json     the optional claims the person declined; a declined claim is not asked again.
--   scopes_json              the `pkey:*` and `offline_access` scopes the grant holds.
--   scope_hash               §12.7.3's function over what the request showed, so a grant covers a
--                            request when its hash matches.
--   granted_at, changed_at, last_used_at  epoch seconds.
--
-- A subject store (`identity.clientGrants`, registered by I-21.15): merged, exported and deleted
-- with the account's data and the product. Owned by identity. No foreign keys, no cascades.
-- Expand-only. Rollback: scripts/rollback/0164_c_identity_client_grants.down.sql.
CREATE TABLE IF NOT EXISTS identity_client_grants (
  account_id           TEXT NOT NULL,
  client_id            TEXT NOT NULL,
  product              TEXT NOT NULL,
  claims_granted_json  TEXT NOT NULL DEFAULT '[]',
  claims_declined_json TEXT NOT NULL DEFAULT '[]',
  scopes_json          TEXT NOT NULL DEFAULT '[]',
  scope_hash           TEXT NOT NULL,
  granted_at           INTEGER NOT NULL,
  changed_at           INTEGER NOT NULL,
  last_used_at         INTEGER,
  PRIMARY KEY (product, account_id, client_id)
);
CREATE INDEX IF NOT EXISTS identity_client_grants_client
  ON identity_client_grants (client_id);
