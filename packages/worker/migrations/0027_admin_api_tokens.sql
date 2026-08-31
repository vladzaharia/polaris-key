-- 0027 — a real admin API credential (A2-02 / A2-05).
--
-- THE DEFECT. The admin API had exactly ONE credential: the console's OIDC browser session. So
-- `pkey bundle` — a build-tool command run from a terminal and from CI — authenticated by having
-- the operator paste their live `__Host-pkey_admin` cookie into `PKEY_ADMIN_COOKIE`, then
-- impersonate a browser well enough to satisfy the CSRF double-submit (GET /manage/api/me for the
-- token, echo it in `X-PKey-CSRF`). Its own header called that "pre-launch operator-grade
-- pragmatism". The costs were real and compounding: a session cookie carries the operator's FULL
-- admin authority with no way to narrow it, it is bearer-equivalent once copied out of the
-- browser, it cannot be revoked without ending every other session that identity holds, its use
-- is indistinguishable in the audit log from the human clicking in the console, and it was being
-- sent to whatever `--base-url` the caller named because nothing checked the scheme.
--
-- THE SHAPE. A separate credential class with its own row, its own lifetime and its own,
-- deliberately narrow, authority.
--
--   token_hash    `hashKey(token, KEY_HASH_PEPPER)` — the SAME treatment license keys and device
--                 tokens get. The plaintext is shown once, at mint, and never stored: a D1 dump
--                 confirms no guess without the pepper, and a support screenshot of this table
--                 hands over nothing.
--   scopes_json   a JSON array of coarse scope strings. Exactly ONE scope exists today
--                 (`bundles:mint`) because exactly one caller exists; `admin/apiTokens.ts`
--                 explains why a scope the dispatcher cannot yet enforce would be worse than no
--                 scope at all.
--   expires_at    NOT NULL, on purpose. Every other credential here is either short-lived by
--                 construction (the 8-hour session) or tied to a device row that can be
--                 deauthorized; a machine credential with no clock on it is the one that outlives
--                 the laptop it was minted for. Making the column nullable would have made
--                 "forever" the value you get by leaving a field blank.
--   revoked_at    an operator kill switch that does not need the token back to work.
--   last_used_at  the only signal that distinguishes a live integration from a forgotten one, so
--                 an operator revoking stale tokens is not guessing.
--
-- The unique index is GLOBAL and not product-scoped: unlike a license key, this credential is not
-- a product's — it is the platform's. It is also the lookup path for every token-authenticated
-- request, so it is added to the `schema_index_assertion` set below (0018's mechanism), which is
-- why this migration re-asserts the whole list the way 0026 did.
--
-- REPLAY. Every statement is `IF NOT EXISTS` or an idempotent DELETE+INSERT; there is no ALTER
-- here, so a replay is a no-op rather than a `duplicate column name`.
--
-- The `CREATE TABLE` keeps one column per line and closes on its own line: the docs data-model
-- generator (`packages/docs/scripts/gen-reference.mjs`) parses this file literally.

CREATE TABLE IF NOT EXISTS admin_api_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_api_tokens_hash
  ON admin_api_tokens(token_hash);

-- Re-assert the required-index set with the token-hash index added (0018 explains the mechanism;
-- 0026 is the previous re-assertion). It is a new file rather than an edit to 0026 for the reason
-- 0026 gives for not editing 0018: D1 records the older migration as applied and will never re-run
-- it, so an edit there would assert the new index on fresh databases only — everywhere except
-- production. `test/scheduled.test.ts` reads the NEWEST assertion list and compares it to
-- `REQUIRED_INDEXES`, so the two still cannot drift.
DELETE FROM schema_index_assertion;

WITH required(name) AS (
  VALUES
    ('idx_admin_api_tokens_hash'),
    ('idx_audit_time'),
    ('idx_devices_license_status'),
    ('idx_devices_seat'),
    ('idx_licenses_email_lower'),
    ('idx_licenses_enroll_hwid'),
    ('idx_licenses_origin'),
    ('idx_licenses_sub'),
    ('idx_licenses_sub_global'),
    ('idx_portal_account_emails_account'),
    ('idx_portal_account_identities_account'),
    ('idx_portal_audit_at'),
    ('idx_portal_audit_product_at'),
    ('idx_portal_license_links_license'),
    ('idx_product_keys_one_active'),
    ('idx_product_keys_one_active_anchor'),
    ('idx_product_keys_verify'),
    ('idx_release_download_tokens_expiry'),
    ('idx_release_download_tokens_hash')
)
INSERT INTO schema_index_assertion (id, expected, found, missing)
SELECT
  1,
  (SELECT COUNT(*) FROM required),
  (SELECT COUNT(*) FROM required r
    WHERE EXISTS (SELECT 1 FROM sqlite_master m
                   WHERE m.type = 'index' AND m.name = r.name)),
  (SELECT COALESCE(group_concat(r.name, ', '), '')
     FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m
                       WHERE m.type = 'index' AND m.name = r.name));
