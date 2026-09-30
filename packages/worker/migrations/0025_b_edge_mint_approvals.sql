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
--
-- `open_registration_acknowledged` binds the operator's open-registration acknowledgement to the
-- approval. Registration is not a recipe column — it lives on the product and a `.pkey/product`
-- push can change it (declare `devices.registration: open`, or turn License off so the derived
-- policy becomes open). So the mint route re-checks it on every request: while the product's
-- EFFECTIVE registration is `open`, an approval matches only if this flag is 1. An approval
-- given under requires-license therefore stops matching the moment a push opens registration,
-- and the recipe answers 404 until an operator re-approves it with the acknowledgement.
CREATE TABLE IF NOT EXISTS edge_mint_approvals (
  product              TEXT NOT NULL REFERENCES products(slug),
  id                   TEXT NOT NULL,
  alg                  TEXT NOT NULL,
  signing_key_secret   TEXT NOT NULL,
  kid                  TEXT,
  claims_template_json TEXT,
  ttl_seconds          INTEGER NOT NULL,
  audience             TEXT,
  open_registration_acknowledged INTEGER NOT NULL DEFAULT 0,
  approved_at          INTEGER NOT NULL,
  approved_by          TEXT NOT NULL,
  PRIMARY KEY (product, id)
);

-- ── Backfill: deployed products keep minting through the upgrade ─────────────────────────────
--
-- This trusts today's references, which is the status quo rather than a weakening: every
-- secret marked here was already mintable before this migration, and every recipe approved
-- here already minted under the product's current registration policy — so the backfill also
-- records the open-registration acknowledgement (1), or an existing open-registration product
-- would stop minting on deploy. An operator reviews the list once after deploy:
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
   open_registration_acknowledged, approved_at, approved_by)
SELECT product, id, alg, signing_key_secret, kid, claims_template_json, ttl_seconds, audience,
       1, CAST(strftime('%s', 'now') AS INTEGER), 'migration'
  FROM edge_mint_config;
