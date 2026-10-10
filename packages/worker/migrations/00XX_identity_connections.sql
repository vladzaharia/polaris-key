-- I-30 (plans/I-27.md §2.3, §6): connections, the one upstream-OIDC concept.
--
-- `identity_connections`: one row per upstream OpenID Connect provider the platform (`scope =
-- 'platform'`) or a product (`scope = 'product:<slug>'`, I-32) signs people in through. Every row
-- is driven by the one relying-party client, `src/core/oidc/client.ts`.
--
--   id                    `[A-Za-z0-9_-]{1,64}`: the env seed's fixed id, or `conn_` + random.
--                         Built-ins later use their kind (`google`, `apple`, `steam`; I-31).
--   label                 What the card's button says ("Continue with <label>").
--   issuer                https only (`isSafeIssuerUrl`); a product row must also pass
--                         `OIDC_ISSUER_ALLOWLIST`. The discovery base and the ID token's `iss`.
--   client_secret_sealed  A platform row's secret, sealed under PLATFORM_KEK with the AAD
--                         `pkey:v2:_platform:identity-connection:<id>`. Never read back out.
--   client_secret_ref     A product row names a product secret instead (I-32).
--   jwks_uri              Optional, for token-only issuers (I-32). Its host joins the gated
--                         fetch's allowlist beside the issuer's.
--   audience              Who signs in through it. Only a platform row may be `operators` or
--                         `both`; a console write of either waits for ST-32's Superadmin gate.
--   claim_map_json        `{groups?, claims?[], name?, picture?, birthdate?}`: which ID-token
--                         claim feeds what. Only mapped values are ever kept (on the link).
--   exchange              Token exchange (I-13, I-32): product rows only.
--   status                `active` or `disabled`.
--   source                `env` (the I-30 seed), `console` (I-31) or `manifest` (I-35).
--
-- `identity_connection_domains`: the email domains a connection claims, each proved by a DNS TXT
-- record `_pkey-challenge.<domain>` holding `pkey-domain-verification=<token>`, one token per
-- connection and domain. Exact domains only: `example.com` never covers `sub.example.com`.
-- `verified_at` NULL is unverified, and an unverified domain does not route, vouch or enforce.
-- `checked_at` is the last time the resolver answered conclusively; the daily re-check unverifies
-- at once on an answer without the token, and after 72 h of resolver errors. The partial unique
-- index gives each `(scope, domain)` at most one verified owner.
--
-- Expand only: the Worker deployed before I-30 never names either table. Each statement is
-- `IF NOT EXISTS`, so the file converges on replay. Rollback:
-- scripts/rollback/00XX_identity_connections.down.sql. Identity owns both tables; other code reads
-- them only through `src/core/oidc/connections.ts`.

CREATE TABLE IF NOT EXISTS identity_connections (
  id                   TEXT PRIMARY KEY,
  scope                TEXT NOT NULL,
  label                TEXT NOT NULL,
  issuer               TEXT NOT NULL,
  client_id            TEXT NOT NULL,
  client_secret_sealed TEXT,
  client_secret_ref    TEXT,
  jwks_uri             TEXT,
  audience             TEXT NOT NULL DEFAULT 'customers',
  claim_map_json       TEXT NOT NULL DEFAULT '{}',
  exchange             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',
  source               TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  modified_at          INTEGER NOT NULL,
  last_success_at      INTEGER,
  last_error_json      TEXT,
  CHECK (scope = 'platform' OR scope LIKE 'product:_%'),
  CHECK (audience IN ('customers', 'operators', 'both')),
  CHECK (scope = 'platform' OR audience = 'customers'),
  CHECK (scope LIKE 'product:_%' OR exchange = 0),
  CHECK (status IN ('active', 'disabled')),
  CHECK (source IN ('env', 'console', 'manifest')),
  UNIQUE (scope, issuer, client_id)
);

CREATE TABLE IF NOT EXISTS identity_connection_domains (
  connection_id TEXT NOT NULL REFERENCES identity_connections(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL,
  domain        TEXT NOT NULL,
  token         TEXT NOT NULL,
  verified_at   INTEGER,
  checked_at    INTEGER,
  enforce       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, domain)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_connection_domains_owner
  ON identity_connection_domains(scope, domain) WHERE verified_at IS NOT NULL;
