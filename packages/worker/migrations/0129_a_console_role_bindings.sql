-- ST-31 slice 1 (ST-28 plan §5.1): operator-owned console role bindings.
--
-- Owner: core (TABLE_OWNERS). One row is one grant of a console role to a member (`account_id`) or
-- an invite to an address (`email_norm`, until the first strong sign-in converts it). Nothing
-- reads the table yet (31.2 wires the principal), so this slice changes no behaviour.
--
-- The lead renumbers 0129 at merge. Expand-only: an old Worker never names the table and ignores
-- it. Rollback: scripts/rollback/0129_a_console_role_bindings.down.sql.
CREATE TABLE IF NOT EXISTS console_role_bindings (
  id          TEXT PRIMARY KEY,                                   -- crb_ + 22 base64url
  account_id  TEXT REFERENCES accounts(id) ON DELETE CASCADE,     -- a member
  email_norm  TEXT,                                               -- an invite, until converted
  role        TEXT NOT NULL,
  scope       TEXT NOT NULL,                                      -- platform | products:* | product:<slug>
  areas_json  TEXT,                                               -- NULL = every area
  source      TEXT NOT NULL,                                      -- grant | invite | creator
  granted_by  TEXT,                                               -- the granter's mbr_ id; NULL = system
  granted_at  INTEGER NOT NULL,
  expires_at  INTEGER,                                            -- invites only: granted_at + 7 days
  CHECK ((account_id IS NULL) <> (email_norm IS NULL)),
  CHECK (role IN ('superadmin', 'platform_admin', 'product_admin', 'console_access')),
  CHECK (scope = 'platform' OR scope = 'products:*' OR scope LIKE 'product:_%'),
  CHECK ((role = 'product_admin') = (scope <> 'platform')),
  CHECK (areas_json IS NULL OR role = 'product_admin'),
  CHECK (expires_at IS NULL OR email_norm IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crb_account
  ON console_role_bindings(account_id, role, scope) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crb_email
  ON console_role_bindings(email_norm, role, scope) WHERE email_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crb_scope ON console_role_bindings(scope);
