-- I-01 (S-16 G14): portal identities are keyed by the issuer that minted the subject.
--
-- `portal_account_identities.provider` used to hold the literal "oidc" for every row
-- (`portal/auth.ts`), so the `(provider, subject)` key carried no issuer at all and a second
-- issuer's subjects would have shared the platform IdP's namespace. From this migration on the
-- column holds the issuer URL exactly as configured (`PLATFORM_OIDC_ISSUER`).
--
-- Backfill. The platform issuer is a Worker secret that D1 SQL cannot read, so the existing rows
-- are re-keyed by the Worker, not here: before every portal OIDC sign-in,
-- `rekeyLegacyPortalIdentities` (`services/identity/portal/repo.ts`) runs
--   UPDATE OR IGNORE portal_account_identities SET provider = <issuer> WHERE provider = 'oidc'
-- which is idempotent and, once the legacy rows are gone, a single empty primary-key search.
-- Every legacy row was written by the platform-issuer flow (the only writer), so re-keying them
-- to that issuer is exact.
--
-- This migration adds the data-layer guard only, and it is expand-only: a new row must be keyed
-- by an http(s) issuer URL OR by the legacy literal 'oidc'. The literal stays allowed because
-- deploy.yml applies migrations before deploying the Worker, and a Worker that is still serving
-- (the window between the two steps, a failed deploy after the migration step) or one rolled back
-- to in Cloudflare writes provider = 'oidc' on every first-time portal sign-in. Refusing it would
-- break new-user sign-in with no code-side recovery. Any such row is re-keyed to the issuer by
-- `rekeyLegacyPortalIdentities` at that user's next sign-in on the I-01 Worker. Every other value
-- (an empty string, a bare provider kind such as 'google') is refused. Refusing the literal too
-- belongs to a later contract-phase migration, once no pre-I-01 Worker can serve.
-- Existing rows are untouched and the column name does not change, so the migration is safe on a
-- production-shaped copy and a Worker deployed before it keeps working unchanged.
--
-- Rollback: the trigger never refuses what a pre-I-01 Worker writes, so a Worker rollback needs no
-- SQL. To also restore the data shape (optional; the pre-I-01 Worker looks rows up by the literal,
-- so re-keyed users would otherwise be matched by verified email or get a fresh account):
--   DROP TRIGGER IF EXISTS trg_portal_identities_issuer_ins;
--   UPDATE OR IGNORE portal_account_identities SET provider = 'oidc' WHERE provider = '<issuer>';

CREATE TRIGGER IF NOT EXISTS trg_portal_identities_issuer_ins
BEFORE INSERT ON portal_account_identities
WHEN NEW.provider <> 'oidc'
  AND NEW.provider NOT LIKE 'https://%'
  AND NEW.provider NOT LIKE 'http://%'
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: portal_account_identities.provider'); END;
