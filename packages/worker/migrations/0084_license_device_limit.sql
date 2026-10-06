-- LX-14a (docs/design/SIGN-IN.md D-53, plans/I-04.md §F.6): a per-licence device limit.
--
-- `licenses.device_limit` is the licence's own seat limit: a positive integer, or NULL to inherit.
-- It is the most specific value, so it beats the tier's `policy_device_limit`, which beats a
-- `deviceLimit` entitlement (profiles, store grants, licence overrides), which beats the product
-- default (`core/entitlements.ts` `injectAdminPolicy`, `core/authz.ts` `licenseDeviceLimit`). The
-- signed licence document carries the resolved number in its existing `deviceLimit` entitlement,
-- so the document's shape does not change.
--
-- Written only by the admin licence PATCH (`deviceLimit`), audited as `license.device_limit.set`.
-- OIDC sign-in never writes it. Existing rows inherit (NULL), so nothing changes on migration.
ALTER TABLE licenses ADD COLUMN device_limit INTEGER
  CHECK (device_limit IS NULL OR device_limit > 0);
