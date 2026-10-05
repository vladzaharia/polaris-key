-- PX-W10 (docs/design/PORTAL.md §4.16, §10.2 G24, G25): Discover.
--
-- `portal_product_settings.discover_enabled` — the per-product Discover opt-out. Discover lists a
-- product when its licence policy WOULD auto-issue to the signed-in account (the product's
-- `oidcDefault` auto-issue rule, or a `groupRoleMap` group the account belongs to), evaluated
-- without issuing. A developer who wants the policy to keep issuing on sign-in, without offering
-- the product in the portal, sets this to 0. Default 1: an auto-issue policy is already the
-- developer's statement that the account may have the product for free.
--
-- `portal_account_identities.groups_json` — the `groups` claim the platform IdP asserted at the
-- account's last portal sign-in, as a JSON array of strings. The product sign-in's tier rule reads
-- the same claim from the same IdP (`services/identity/oidc.ts`, `identityTier`), so Discover can
-- evaluate a `groupRoleMap` for the account without a product sign-in. NULL = not known yet (a row
-- written before this migration, or by a Worker that predates it): such an account sees no group
-- offers until it next signs in, never a wrong one.
--
-- Expand-only: two columns with constant defaults on existing tables. A Worker deployed before this
-- migration never names them, and a row it writes reads back with Discover on and no groups.
--
-- Rollback: a pre-PX-W10 Worker ignores both columns, so no SQL is needed. To drop them anyway:
--   ALTER TABLE portal_product_settings DROP COLUMN discover_enabled;
--   ALTER TABLE portal_account_identities DROP COLUMN groups_json;

ALTER TABLE portal_product_settings ADD COLUMN discover_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_account_identities ADD COLUMN groups_json TEXT;
