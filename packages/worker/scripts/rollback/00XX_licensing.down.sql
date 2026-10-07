-- LX-08 rollback: the `down` path of migrations 00XX_a..m (plans/LX-01.md §6.1).
--
-- WHEN. Only after rolling the Worker back to a build before LX-08. That Worker reads the old
-- objects only: `license_store_grants` (which the LX-08 Worker kept writing, so nothing is lost
-- there), `dist_store_products.flag` and `dist_purchases.license_id` (likewise), and the licence's
-- `overrides_json` for its OIDC-provisioned entitlement keys. That last one is the one thing the
-- LX-08 Worker MOVED: a sign-in, the deploy hook and the nightly catch-up take the provisioned keys
-- out of the column into the licence's `oidc` grant (`grt_oidc_<license_id>`). Without this script
-- an old Worker would serve those licences without them (djdl's `polarisVpn`) until each signs in
-- again. This script copies every active `oidc` grant's keys back into the column.
--
-- WHAT IT COPIES. Each key of the licence's active `oidc` grant that the column does not already
-- carry (an operator's override of the key still wins, exactly as the LX-08 Worker rendered it),
-- with its stored state, value and `updatedAt`, appended to `overrides_json.entitlements`, which is
-- where LX-02's sign-in writer kept them (after every other key), so the old Worker's documents
-- are the LX-08 Worker's byte for byte. A value of JSON `null` cannot survive `json_patch` (RFC 7396
-- deletes it); no provisioning hook writes one (`representabilityIssue`).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/00XX_licensing.down.sql
-- It is idempotent: a key it copied is then carried by the column, so a second run copies nothing.
-- It leaves the LX-08 tables, columns, triggers and grant rows in place: the old Worker never names
-- them, and keeping them lets a roll-forward pick up where it stopped (the catch-up moves the keys
-- out again, and the projection re-converges the store grants). It is exercised by
-- test/licensingExpand.test.ts.

UPDATE licenses
   SET overrides_json = json_patch(
         CASE
           WHEN overrides_json IS NOT NULL AND json_valid(overrides_json)
                AND json_type(overrides_json) = 'object'
           THEN overrides_json
           ELSE '{}'
         END,
         json_object('entitlements', (
           SELECT json_group_object(e.key, json_object(
                    'state', e.state, 'value', json(e.value_json), 'updatedAt', e.updated_at))
             FROM (SELECT ge.key, ge.state, ge.value_json, ge.updated_at
                     FROM grants g
                     JOIN grant_entitlements ge ON ge.product = g.product AND ge.grant_id = g.id
                    WHERE g.product = licenses.product
                      AND g.id = 'grt_oidc_' || licenses.id
                      AND g.license_id = licenses.id
                      AND g.state = 'active'
                      AND json_type(
                            CASE WHEN json_valid(licenses.overrides_json)
                                 THEN licenses.overrides_json ELSE '{}' END,
                            '$.entitlements."' || ge.key || '"') IS NULL
                    ORDER BY ge.key) e)))
 WHERE EXISTS (
   SELECT 1
     FROM grants g
     JOIN grant_entitlements ge ON ge.product = g.product AND ge.grant_id = g.id
    WHERE g.product = licenses.product
      AND g.id = 'grt_oidc_' || licenses.id
      AND g.license_id = licenses.id
      AND g.state = 'active'
      AND json_type(
            CASE WHEN json_valid(licenses.overrides_json)
                 THEN licenses.overrides_json ELSE '{}' END,
            '$.entitlements."' || ge.key || '"') IS NULL);
