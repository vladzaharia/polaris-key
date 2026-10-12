-- 0119 — a real admin API credential: the `pkeya_` token.
--
-- THE DEFECT. The admin API had exactly ONE credential: the console's OIDC browser session. So
-- `pkey bundle`, a build-tool command run from a terminal and from CI, authenticated by having the
-- operator paste their live `__Host-pkey_admin` cookie into `PKEY_ADMIN_COOKIE`, then impersonate a
-- browser well enough to satisfy the CSRF double-submit (GET /manage/api/me for the token, echo it
-- in `X-PKey-CSRF`). The costs were real and compounding: a session cookie carries the operator's
-- FULL admin authority with no way to narrow it, it is bearer-equivalent once copied out of the
-- browser, it cannot be revoked without ending every other session that identity holds, its use is
-- indistinguishable in the audit log from the human clicking in the console, and it was being sent
-- to whatever `--base-url` the caller named because nothing checked the scheme.
--
-- THE SHAPE. A separate credential class with its own row, its own lifetime and its own,
-- deliberately narrow, authority.
--
--   token_hash    `hashKey(token, KEY_HASH_PEPPER)`: the SAME treatment licence keys and device
--                 tokens get. The plaintext is shown once, at mint, and never stored: a D1 dump
--                 confirms no guess without the pepper, and a support screenshot of this table
--                 hands over nothing.
--   scopes_json   a JSON array of coarse scope strings. Exactly ONE scope exists today
--                 (`bundles:mint`) because exactly one caller exists; `console/apiTokens.ts`
--                 explains why a scope the dispatcher cannot yet enforce would be worse than no
--                 scope at all.
--   expires_at    NOT NULL, on purpose. The console session is short-lived by construction (8
--                 hours); a machine credential with no clock on it is the one that outlives the
--                 laptop it was minted for. Making the column nullable would have made "forever"
--                 the value you get by leaving a field blank.
--   revoked_at    an operator kill switch that does not need the token back to work. A revoked row
--                 is kept, not deleted: the roster is the lifecycle record.
--   last_used_at  the only signal that distinguishes a live integration from a forgotten one, so an
--                 operator revoking stale tokens is not guessing.
--
-- The unique index is GLOBAL and not product-scoped: unlike a licence key, this credential is not a
-- product's, it is the platform's. It is also the lookup path for every token-authenticated
-- request, so `0119_b_index_assertion.sql` adds it to the required-index set (0018's mechanism).
--
-- REPLAY. Every statement is `IF NOT EXISTS`; there is no ALTER here, so a replay is a no-op rather
-- than a `duplicate column name`.
--
-- The `CREATE TABLE` keeps one column per line and closes on its own line: the docs data-model
-- generator (`packages/docs/scripts/gen-reference.mjs`) parses this file literally. Core owns the
-- table (`TABLE_OWNERS.core`).

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
