-- F-21 (plans/F-20.md §6.1): registry tokens, the `pkeyr_` credential package-feed clients present
-- on the registry host (`pkg.plrs.im`). Core's (`TABLE_OWNERS.core` in the docs generator): two
-- services mint them, Distribution from the console and Identity from the portal, and neither may
-- import the other (rule 6). Written only by `src/core/registryTokens.ts`. Idempotent statements.
--
--   token_id        `rtok_<12>`, unique within the owner; the list UI and the audit trail name it
--   token_hash      HMAC-SHA256 of the plaintext under KEY_HASH_PEPPER (as `ci_tokens`); the
--                   plaintext is shown once and never stored, logged or echoed
--   hint            the plaintext's last four characters, for the list
--   scopes_json     `["read"]`; `publish` is reserved for F-22 and F-23 and refused until then
--   ecosystems_json NULL for every feed of the owner, else the ecosystems it is narrowed to
--   binding         `owner` (minted in the console) or `license` (bound to one licence)
--   presentation    `header` (Authorization) or `url` (the Godot editor's tokenised URL; narrow:
--                   read only, `["godot"]` only, by the CHECK below)
--   created_by      `admin:<sub>` or `portal:<accountId>`
--   expires_at      every token expires, at most 365 days out (Q6)
--   last_used_at    written at most hourly, when a resolution reloads the row
--
-- A deleted product needs no write: the lookup joins `products.status <> 'deleted'`. A suspended or
-- expired licence needs none either: its tokens stop at the next check (`licenseUsable`). The cron
-- purges a row 90 days after it expired or was revoked.
CREATE TABLE IF NOT EXISTS registry_tokens (
  product            TEXT NOT NULL REFERENCES products(slug),
  token_id           TEXT NOT NULL,
  token_hash         TEXT NOT NULL,
  hint               TEXT NOT NULL,
  label              TEXT NOT NULL,
  scopes_json        TEXT NOT NULL,
  ecosystems_json    TEXT,
  binding            TEXT NOT NULL CHECK (binding IN ('owner', 'license')),
  license_id         TEXT,
  presentation       TEXT NOT NULL DEFAULT 'header' CHECK (presentation IN ('header', 'url')),
  created_by         TEXT NOT NULL,
  portal_account_id  TEXT,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  revoked_at         INTEGER,
  revoked_by         TEXT,
  revoke_reason      TEXT,
  PRIMARY KEY (product, token_id),
  CHECK ((binding = 'license') = (license_id IS NOT NULL)),
  CHECK (presentation = 'header' OR (ecosystems_json = '["godot"]' AND scopes_json = '["read"]'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_tokens_hash ON registry_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_registry_tokens_license ON registry_tokens(product, license_id);
CREATE INDEX IF NOT EXISTS idx_registry_tokens_account ON registry_tokens(portal_account_id);
