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
-- `open_registration_acknowledged` binds the operator's acknowledgement that the mint is PUBLIC
-- to the approval. Whether it is public is not a recipe column — it lives on the product, and a
-- `.pkey/product` push can make it public in two ways: open registration (declare
-- `devices.registration: open`, or turn License off with Identity off so the derived policy is
-- open), or enable anonymous auto-issue enrolment (`autoIssue.mode` `anonymous`/`both`), which
-- hands any caller a licence and a device token. So the mint route re-checks it on every
-- request: while the mint is public, an approval matches only if this flag is 1. An approval
-- given while the mint was closed therefore stops matching the moment a push makes it public,
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
-- here already minted under the product's CURRENT policy. An operator reviews the list once
-- after deploy:
--
--   SELECT product, name FROM product_secrets WHERE usage = 'edge-mint';
--
-- The acknowledgement is NOT a constant. It is recorded (1) only where the mint is ALREADY
-- public at deploy — that recipe was a public mint before the upgrade, and writing 0 would stop
-- it on deploy. Everywhere else it is 0: the approval covers the policy the product runs today,
-- and a later push that makes the mint public turns the recipe inert until an operator
-- acknowledges it. The CASE mirrors `mintIsPublic` (services/config/mint.ts) over the two
-- columns it reads:
--   - registration open: `resolveRegistration(parseServices(services_json))` is `open` when
--     `registration` is declared `open`, or undeclared with License off and Identity off
--     (License defaults ON, Identity OFF — `DEFAULT_SERVICES`);
--   - anonymous enrolment: `allowsAnonymousEnroll(parseAutoIssue(auto_issue_json))` —
--     `enabled` is true, `tierId` a non-empty string, and `mode` anything but `oidcDefault`
--     (an absent or unknown mode parses as `anonymous`).
-- Where the SQL and the parsers could disagree (malformed JSON the parsers fall back on) the
-- JSON checks mostly read as closed, which errs toward 0: the recipe shows `changed` on the
-- setup checklist and waits for an operator rather than minting publicly.
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
SELECT c.product, c.id, c.alg, c.signing_key_secret, c.kid, c.claims_template_json,
       c.ttl_seconds, c.audience,
       CASE
         WHEN json_valid(p.services_json)
              AND json_type(p.services_json) = 'object'
              AND (json_extract(p.services_json, '$.registration') = 'open'
                   OR (json_type(p.services_json, '$.registration') IS NULL
                       AND json_type(p.services_json, '$.license.enabled') = 'false'
                       AND COALESCE(json_type(p.services_json, '$.identity.enabled'), 'false')
                           = 'false'))
           THEN 1
         WHEN json_valid(p.auto_issue_json)
              AND json_type(p.auto_issue_json) = 'object'
              AND json_type(p.auto_issue_json, '$.enabled') = 'true'
              AND json_type(p.auto_issue_json, '$.tierId') = 'text'
              AND json_extract(p.auto_issue_json, '$.tierId') <> ''
              AND COALESCE(json_extract(p.auto_issue_json, '$.mode'), '') IS NOT 'oidcDefault'
           THEN 1
         ELSE 0
       END,
       CAST(strftime('%s', 'now') AS INTEGER), 'migration'
  FROM edge_mint_config c
  JOIN products p ON p.slug = c.product;
