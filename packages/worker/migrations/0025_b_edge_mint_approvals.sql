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
-- `.pkey/product` push can make it public in three ways: open registration (declare
-- `devices.registration: open`, or turn License off with Identity off so the derived policy is
-- open), anonymous auto-issue enrolment (`autoIssue.mode` `anonymous`/`both`), which hands any
-- caller a licence and a device token, or an OIDC default tier with Identity on
-- (`autoIssue.mode` `oidcDefault`/`both`), which gives every account the identity provider signs
-- in a licence. So the mint route re-checks it on every request: while the mint is public, an
-- approval matches only if this flag is 1. An approval given while the mint was closed therefore
-- stops matching the moment a push makes it public, and the recipe answers 404 until an operator
-- re-approves it with the acknowledgement.
--
-- `license_enabled` records whether the License service was on. The mint checks a device's
-- licence only while it is, so a push that turns License off would let a device whose licence
-- an operator disabled, or that expired, mint again — without making the mint public when
-- Identity is on (the derived registration is then `requires-identity`). While License is off,
-- an approval given with it on does not match. Turning License on only narrows.
--
-- `identity_enabled` and the four `oidc_*` columns bind the SIGN-IN trust the approval was given
-- under: whether the Identity service was on, and the `oidc_config` provider, issuer, client id
-- and group → role/tier map at that moment. On a closed product, sign-in is how device tokens
-- reach people an operator never issued a key to — `activateFromIdentity` licenses any identity
-- whose groups hit the map — and all four values are written from the manifest. While Identity
-- is on, an approval matches only if they are unchanged (the group map compared structurally), so
-- a push that aims sign-in at an issuer the pusher controls, or maps their group onto a tier,
-- makes the recipe inert. Turning Identity off never invalidates an approval: it only narrows.
--
-- Those three product-side conditions (public mint unacknowledged, License off, sign-in trust
-- changed) are also made PERMANENT at ingest: link and resync delete an approval the product has
-- widened (`invalidateWidenedEdgeMintApprovals`, core/edgeMintApproval.ts) and audit it as
-- `config.mint.invalidate`. Otherwise a push that widens issuance and a second push that reverts
-- it would leave the approval applying again while the licences and device tokens issued in
-- between keep working. Recipe-field changes stay non-sticky: a changed recipe signs nothing.
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
  license_enabled      INTEGER NOT NULL DEFAULT 1,
  identity_enabled     INTEGER NOT NULL DEFAULT 0,
  oidc_provider        TEXT,
  oidc_issuer          TEXT,
  oidc_client_id       TEXT,
  oidc_group_role_map_json TEXT,
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
-- acknowledges it. The CASE mirrors `mintIsPublic` (core/edgeMintApproval.ts) over the two
-- columns it reads:
--   - registration open: `resolveRegistration(parseServices(services_json))` is `open` when
--     `registration` is declared `open`, or undeclared with License off and Identity off
--     (License defaults ON, Identity OFF — `DEFAULT_SERVICES`);
--   - anonymous enrolment or an OIDC default tier: `parseAutoIssue(auto_issue_json)` is
--     `enabled` with a non-empty string `tierId`, and `mode` is anything but `oidcDefault` (an
--     absent or unknown mode parses as `anonymous`) — or is `oidcDefault` with Identity on.
-- `license_enabled` and `identity_enabled` are copied from the product as it stands, and the
-- `oidc_*` columns verbatim from `oidc_config` (NULL where the product has no row).
--
-- Every `services_json` read goes through `svc_ok`, which mirrors exactly when `parseServices`
-- (core/services.ts) ACCEPTS the column: valid JSON, an object, and every top-level entry either
-- `registration` with one of the three policies, or a key other than `__proto__` whose value is
-- an object with a boolean `enabled`. Anything else the parser replaces with the defaults
-- (License on, Identity off, registration derived), and so does this backfill — which is what
-- keeps `license_enabled` from recording 0 on a column the parser reads as License on. The one
-- divergence left is a hand-written column with a DUPLICATE key (JSON.parse keeps the last,
-- json_extract the first); `serializeServices` never writes one.
-- `parseAutoIssue` has no whole-value rejection, so its checks read the column directly.
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
   open_registration_acknowledged, license_enabled, identity_enabled, oidc_provider, oidc_issuer,
   oidc_client_id, oidc_group_role_map_json, approved_at, approved_by)
SELECT c.product, c.id, c.alg, c.signing_key_secret, c.kid, c.claims_template_json,
       c.ttl_seconds, c.audience,
       CASE
         -- registration open: declared `open`, or undeclared with License off and Identity off
         -- (an absent service entry takes its default: License on, Identity off).
         WHEN p.svc_ok
              AND (json_extract(p.services_json, '$.registration') = 'open'
                   OR (json_type(p.services_json, '$.registration') IS NULL
                       AND json_type(p.services_json, '$.license.enabled') = 'false'
                       AND COALESCE(json_type(p.services_json, '$.identity.enabled'), 'false')
                           = 'false'))
           THEN 1
         -- anonymous enrolment, or an OIDC default tier with Identity on.
         WHEN json_valid(p.auto_issue_json)
              AND json_type(p.auto_issue_json) = 'object'
              AND json_type(p.auto_issue_json, '$.enabled') = 'true'
              AND json_type(p.auto_issue_json, '$.tierId') = 'text'
              AND json_extract(p.auto_issue_json, '$.tierId') <> ''
              AND (COALESCE(json_extract(p.auto_issue_json, '$.mode'), '') IS NOT 'oidcDefault'
                   OR (p.svc_ok
                       AND json_type(p.services_json, '$.identity.enabled') = 'true'))
           THEN 1
         ELSE 0
       END,
       CASE
         WHEN p.svc_ok AND json_type(p.services_json, '$.license.enabled') = 'false' THEN 0
         ELSE 1
       END,
       CASE
         WHEN p.svc_ok AND json_type(p.services_json, '$.identity.enabled') = 'true' THEN 1
         ELSE 0
       END,
       o.provider, o.issuer, o.client_id, o.group_role_map_json,
       CAST(strftime('%s', 'now') AS INTEGER), 'migration'
  FROM edge_mint_config c
  JOIN (
    SELECT slug, services_json, auto_issue_json,
           (json_valid(services_json)
            AND json_type(services_json) = 'object'
            AND NOT EXISTS (
              SELECT 1
                FROM json_each(CASE WHEN json_valid(services_json)
                                     AND json_type(services_json) = 'object'
                                    THEN services_json ELSE '{}' END) AS j
               WHERE CASE
                       WHEN j.key = 'registration'
                         THEN NOT (j.type = 'text'
                                   AND j.atom IN ('open', 'requires-identity', 'requires-license'))
                       WHEN j.key = '__proto__' THEN 1
                       ELSE NOT (j.type = 'object'
                                 AND json_type(j.value, '$.enabled') IN ('true', 'false'))
                     END
            )) AS svc_ok
      FROM products
  ) p ON p.slug = c.product
  LEFT JOIN oidc_config o ON o.product = c.product;
