-- P0-12 — operator approval of edge-mint recipes.
--
-- A recipe (`edge_mint_config`) is written from a linked repo's `.pkey/` manifest on every link
-- and resync, so on its own it is repo-authored policy. This table is the operator's half: the
-- EXACT security-relevant fields an operator approved. The mint route signs only when the
-- current recipe row equals its approval column for column (alg, signing_key_secret, kid,
-- claims_template_json, ttl_seconds, audience); anything else answers exactly like an unknown
-- recipe (404 not_found). A push that changes any of those fields makes the recipe inert until
-- it is approved again. Rows are written ONLY by the admin API — never from a manifest — and
-- resync deletes the rows for recipe ids the manifest no longer declares.
--
-- Values are stored rather than hashed so this backfill is a plain INSERT … SELECT and so the
-- console can show an operator exactly what changed.
CREATE TABLE IF NOT EXISTS edge_mint_approvals (
  product              TEXT NOT NULL REFERENCES products(slug),
  id                   TEXT NOT NULL,
  alg                  TEXT NOT NULL,
  signing_key_secret   TEXT NOT NULL,
  kid                  TEXT,
  claims_template_json TEXT,
  ttl_seconds          INTEGER NOT NULL,
  audience             TEXT,
  approved_at          INTEGER NOT NULL,
  approved_by          TEXT NOT NULL,
  PRIMARY KEY (product, id)
);

-- ── Backfill: deployed products keep minting through the upgrade ─────────────────────────────
--
-- This trusts today's references, which is the status quo rather than a weakening: every
-- secret marked here was already mintable before this migration. An operator reviews the list
-- once after deploy:
--
--   SELECT product, name FROM product_secrets WHERE usage = 'edge-mint';
--
-- Both statements are idempotent, so a replay of this file converges on the same end state.
UPDATE product_secrets
   SET usage = 'edge-mint'
 WHERE usage IS NULL
   AND EXISTS (
     SELECT 1 FROM edge_mint_config e
      WHERE e.product = product_secrets.product
        AND e.signing_key_secret = product_secrets.name
   );

INSERT OR IGNORE INTO edge_mint_approvals
  (product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience,
   approved_at, approved_by)
SELECT product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience,
       CAST(strftime('%s', 'now') AS INTEGER), 'migration'
  FROM edge_mint_config;
