-- P2-02 — trusted publishing: the publisher policy, CI tokens and upload tickets
-- (src/core/publisher.ts; README §3.4 "Publishing").
--
-- A GitHub Actions job exchanges its OIDC token for a short-lived `pkeyci_` token when the
-- token's claims satisfy the product's publisher policy; an operator can also issue a static,
-- expiring `pkeyci_` token for a CI that is not GitHub. With a token holding `release:publish`
-- the job obtains an upload ticket (R2 temporary credentials scoped to
-- `staging/<product>/<ticketId>/`) and submits a release descriptor against it.
--
-- Only hashes of credentials are stored: `token_hash` and `ticket_hash` are `hashKey` (HMAC
-- under KEY_HASH_PEPPER), exactly as device tokens and license keys are. The shown-once
-- plaintext never reaches D1.
--
-- Idempotent on replay (0012/0018 conventions): IF NOT EXISTS throughout, no ALTER.

-- The publisher policy: one row per product. Manifest-owned (`source = 'manifest'`) rows are
-- written by link and resync from `.pkey/release` `publishing.trustedPublisher`, with
-- `repository_id`/`repository_owner_id` resolved from GitHub, never from the manifest. Once an
-- operator claims the row (`source = 'admin'`), resync leaves it alone.
CREATE TABLE IF NOT EXISTS ci_publishers (
  product              TEXT PRIMARY KEY REFERENCES products(slug),
  provider             TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  repository_id        INTEGER NOT NULL,
  repository_owner_id  INTEGER NOT NULL,
  -- `owner/repo` as GitHub spells it; the prefix of `job_workflow_ref`.
  repository           TEXT NOT NULL,
  workflow             TEXT NOT NULL,
  environment          TEXT NOT NULL DEFAULT 'release',
  scopes_json          TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'manifest' CHECK (source IN ('manifest', 'admin')),
  created_at           INTEGER NOT NULL,
  modified_at          INTEGER NOT NULL,
  modified_by          TEXT
);

-- Every `pkeyci_` token, minted (`oidc`) or operator-issued (`static`). `jti` is the GitHub OIDC
-- token's id for a minted token (NULL for a static one); its UNIQUE index is what makes the
-- exchange single-use in D1, atomically.
--
-- Product-first primary key like every tenant table (R11-05); the bearer carries no product, so
-- the lookup goes through `idx_ci_tokens_hash`, which also makes the hash GLOBALLY unique — the
-- real invariant for a 256-bit secret, as `idx_release_download_tokens_hash` (0015) is.
CREATE TABLE IF NOT EXISTS ci_tokens (
  product      TEXT NOT NULL REFERENCES products(slug),
  token_hash   TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('oidc', 'static')),
  scopes_json  TEXT NOT NULL,
  subject      TEXT NOT NULL,
  label        TEXT,
  jti          TEXT,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  created_by   TEXT NOT NULL,
  PRIMARY KEY (product, token_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_tokens_hash ON ci_tokens(token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_tokens_jti ON ci_tokens(jti);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_tokens_id ON ci_tokens(token_id);
CREATE INDEX IF NOT EXISTS idx_ci_tokens_product ON ci_tokens(product, issued_at DESC);

-- Upload tickets. `objects_json` is the `[{sha256, size, gated}]` the ticket was issued for; a
-- submit may promote only those. `redeemed_at` is set by the submit that consumed it — a ticket
-- is redeemed once.
CREATE TABLE IF NOT EXISTS ci_upload_tickets (
  product       TEXT NOT NULL REFERENCES products(slug),
  ticket_hash   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  objects_json  TEXT NOT NULL,
  issued_at     INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  redeemed_at   INTEGER,
  PRIMARY KEY (product, ticket_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_upload_tickets_hash ON ci_upload_tickets(ticket_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ci_upload_tickets_id ON ci_upload_tickets(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ci_upload_tickets_expiry ON ci_upload_tickets(expires_at);
