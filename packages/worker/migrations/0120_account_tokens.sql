-- 0120 — personal tokens: the `pkeyp_` credential a PERSON holds (F-33, plans/I-27.md §2.5).
--
-- A person, not a product, owns this credential: one token installs every package the account may
-- read, across products. `registry_tokens` is product-keyed (every row names the product that owns
-- the feed), so a person-wide token does not fit there; this is the account's own table, beside
-- `admin_api_tokens` (0119), the platform's.
--
--   token_hash    `hashKey(token, KEY_HASH_PEPPER)`: the same treatment licence keys, device
--                 tokens and `pkeya_` tokens get. The plaintext is shown once, at mint, and never
--                 stored. NOTE FOR SEC-pepper: this is a plain hash column. The `hash_pepper_id`
--                 stamp, its fence trigger and the by-token-id revoke are added by that package
--                 as a later `ALTER` / trigger, exactly as for `admin_api_tokens`; nothing here
--                 needs to change for it.
--   scope         EXACTLY ONE scope per token (a column, not a list: exclusivity is the shape).
--                 `packages:read` today; ST-34 adds `admin`. There is deliberately no CHECK on the
--                 values: widening a CHECK in SQLite is a table rebuild, and the code refuses an
--                 unknown scope at mint and at use (`core/accounts/personalTokens.ts`).
--   expires_at    NOT NULL, for the reason `admin_api_tokens.expires_at` is: a credential with no
--                 clock on it outlives the laptop it was minted for.
--   last_used_at  the signal that tells a live install from a forgotten token.
--   revoked_by / revoke_reason
--                 who ended it and why: `manual` (the person), `admin` (a Superadmin),
--                 `account_deleted` (erasure), `access_removed` (the account lost the access the
--                 token reads through, if ever a rule needs it). A merge is not a revoke: the
--                 tokens follow the surviving account.
--
-- The account id is NOT a foreign key: erasure revokes the rows in its batch and the nightly purge
-- removes them 90 days later, and a restored backup must not fail on an account that was erased
-- after it was taken (the erasure ledger fences those; see `core/accounts/erasureFence.ts`).
--
-- REPLAY. Every statement is `IF NOT EXISTS`; there is no ALTER, so a replay is a no-op.
--
-- The `CREATE TABLE` keeps one column per line and closes on its own line: the docs data-model
-- generator parses this file literally. Core owns the table (`TABLE_OWNERS.core`).

CREATE TABLE IF NOT EXISTS account_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  hint TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_hash
  ON account_tokens(token_hash);

CREATE INDEX IF NOT EXISTS idx_account_tokens_account
  ON account_tokens(account_id, created_at DESC);
