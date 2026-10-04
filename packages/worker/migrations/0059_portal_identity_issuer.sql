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
-- This migration adds the data-layer guard only: a new row must be keyed by an http(s) issuer
-- URL, so no code path can write the issuer-less literal again. Existing rows are untouched, so
-- it is safe on a production-shaped copy, and the column name does not change, so a Worker
-- deployed before this migration keeps reading the table. Only that older Worker's first-time
-- portal OIDC sign-ins (which insert the literal) fail until the matching Worker is deployed.
--
-- Rollback (both statements; the second only if the pre-I-01 Worker is redeployed, since it
-- matches the literal):
--   DROP TRIGGER IF EXISTS trg_portal_identities_issuer_ins;
--   UPDATE OR IGNORE portal_account_identities SET provider = 'oidc' WHERE provider = '<issuer>';

CREATE TRIGGER IF NOT EXISTS trg_portal_identities_issuer_ins
BEFORE INSERT ON portal_account_identities
WHEN NEW.provider NOT LIKE 'https://%' AND NEW.provider NOT LIKE 'http://%'
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: portal_account_identities.provider'); END;
