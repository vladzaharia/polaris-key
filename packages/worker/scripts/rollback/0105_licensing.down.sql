-- LX-08 rollback: the `down` path of migrations 0105_a..m (plans/LX-01.md §6.1).
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
-- THEN IT EMPTIES THE `oidc` GRANTS. Every `oidc` grant entry whose key the column now carries is
-- deleted, and so is every `oidc` grant left with no entry, so the column is again the ONLY source
-- of the provisioned keys. Otherwise a roll-forward would revive what the old Worker revoked in
-- between: its sign-in removes a key whose claim disappeared from the column, and an LX-08 Worker
-- would then render the stale grant entry in its place.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0105_licensing.down.sql
-- It is idempotent: a key it copied is then carried by the column and no longer in a grant, so a
-- second run copies and deletes nothing. It leaves the LX-08 tables, columns, triggers and the
-- store grants' rows in place: the old Worker never names them. A roll-forward afterwards starts
-- the provisioned-keys move over, exactly as the first deploy did (each sign-in and the catch-up
-- move the keys out of the column again), and the catch-up re-projects the store grants the old
-- Worker wrote meanwhile. It is exercised by test/licensingExpand.test.ts.

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

-- The copied keys leave the `oidc` grants: the column is their only source again.
DELETE FROM grant_entitlements
 WHERE EXISTS (
   SELECT 1
     FROM grants g
     JOIN licenses l ON l.product = g.product AND l.id = g.license_id
    WHERE g.product = grant_entitlements.product
      AND g.id = grant_entitlements.grant_id
      AND g.source = 'oidc'
      AND g.id = 'grt_oidc_' || l.id
      AND json_type(
            CASE WHEN json_valid(l.overrides_json) THEN l.overrides_json ELSE '{}' END,
            '$.entitlements."' || grant_entitlements.key || '"') IS NOT NULL);

DELETE FROM grants
 WHERE source = 'oidc'
   AND NOT EXISTS (SELECT 1 FROM grant_entitlements ge
                    WHERE ge.product = grants.product AND ge.grant_id = grants.id);
