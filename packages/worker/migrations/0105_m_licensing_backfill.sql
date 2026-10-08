-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.14 step 2): the licences' vocabulary and index, and
-- the backfill of the existing store grants into the licensing model's tables.
--
-- REPLAYABLE AND RESUMABLE. Every statement is `IF NOT EXISTS`, `INSERT … ON CONFLICT` with a
-- guard that changes nothing when the row already agrees, or an `UPDATE` guarded by its own
-- target state. Grant ids are derived from the purchase (`grt_s_<store>_<purchase_key_hash>`), so
-- a second run, or a run interrupted part-way and started again, converges on the same rows and
-- writes nothing new. Old Worker safe: it reads `license_store_grants` and the `flag` column,
-- neither of which this touches.
--
-- THE SAME STATEMENTS RUN AGAIN AFTER THE DEPLOY. Grants a pre-LX-08 Worker wrote or revoked
-- between this migration and the deploy reach the new tables through the Worker's catch-up
-- (`reconcileStoreGrantsStatements` in src/core/grants.ts: the deploy hook and the nightly
-- maintenance, "licensingCatchUp"), which runs these exact projections in their upsert form. From
-- the deploy on, every store-grant write dual-writes them in its own batch.
--
-- THE PROJECTION (one grant per purchase, licence-held, as `core/storeGrants.ts` renders it):
--
--   grant      one per (product, store, purchase_key_hash) of `license_store_grants`: the
--              purchase's licence; `source` the store; `external_ref_hash` the purchase key hash;
--              `sku` the purchase's `store_product_id`; `state` `active` when any of its flag rows
--              is active, else `revoked`; `granted_at` the earliest grant; `modified_at` the latest
--              grant or revocation; created and modified by `migration`
--   keys       one per flag row that counts: every ACTIVE flag of an active grant (a flag the
--              purchase granted under an earlier mapping and that a refund revoked stays out, as
--              the legacy layer leaves it out), or every flag of a revoked grant (its history);
--              `value_json` `true`, state `default`, `updated_at` the row's `granted_at`
--   purchase   `dist_purchases.grant_id` of every purchase that now has a grant
--   mapping    one `dist_store_product_entitlements` row per `dist_store_products.flag`
--
-- No `tiers.rank` write is needed (the default is 0) and `licenses.account_id` was backfilled by
-- I-05. Rollback: scripts/rollback/0105_licensing.down.sql.

-- A sale-minted licence's external reference is unique per product and source.
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_ext_ref
  ON licenses(product, source, external_ref_hash) WHERE external_ref_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_licenses_ended_reason_ins
BEFORE INSERT ON licenses
WHEN NEW.ended_reason IS NOT NULL AND NEW.ended_reason NOT IN ('revoked', 'refunded', 'chargeback', 'superseded')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.ended_reason'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_ended_reason_upd
BEFORE UPDATE OF ended_reason ON licenses
WHEN NEW.ended_reason IS NOT NULL AND NEW.ended_reason NOT IN ('revoked', 'refunded', 'chargeback', 'superseded')
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.ended_reason'); END;

-- The grants. `WHERE 1` keeps the upsert's SELECT unambiguous (SQLite's documented parsing rule).
INSERT INTO grants
  (product, id, account_id, license_id, store_identity_hash, source, external_ref_hash, sku,
   order_ref, state, granted_at, expires_at, grace_until, shared, trial, created_by, modified_at,
   modified_by)
SELECT s.product, 'grt_s_' || s.store || '_' || s.purchase_key_hash, NULL, MIN(s.license_id), NULL,
       s.store, s.purchase_key_hash,
       (SELECT p.store_product_id FROM dist_purchases p
         WHERE p.product = s.product AND p.store = s.store
           AND p.purchase_key_hash = s.purchase_key_hash),
       NULL,
       CASE WHEN MAX(s.state = 'active') = 1 THEN 'active' ELSE 'revoked' END,
       MIN(s.granted_at), NULL, NULL, 0, 0, 'migration',
       MAX(MAX(s.granted_at), COALESCE(MAX(s.revoked_at), 0)), 'migration'
  FROM license_store_grants s
 WHERE 1
 GROUP BY s.product, s.store, s.purchase_key_hash
ON CONFLICT (product, id) DO UPDATE SET
  license_id = excluded.license_id,
  sku = COALESCE(excluded.sku, grants.sku),
  state = excluded.state,
  granted_at = excluded.granted_at,
  modified_at = excluded.modified_at,
  modified_by = excluded.modified_by
WHERE grants.license_id IS NOT excluded.license_id
   OR grants.sku IS NOT COALESCE(excluded.sku, grants.sku)
   OR grants.state IS NOT excluded.state
   OR grants.granted_at IS NOT excluded.granted_at
   OR grants.modified_at IS NOT excluded.modified_at;

-- Their keys: first drop a key that no longer counts (a re-run after a refund), then write the
-- ones that do.
DELETE FROM grant_entitlements
 WHERE grant_id IN (SELECT g.id FROM grants g
                     WHERE g.product = grant_entitlements.product
                       AND g.source IN ('app-store', 'play', 'steam'))
   AND NOT EXISTS (
     SELECT 1 FROM license_store_grants s
      WHERE s.product = grant_entitlements.product
        AND 'grt_s_' || s.store || '_' || s.purchase_key_hash = grant_entitlements.grant_id
        AND s.flag = grant_entitlements.key
        AND (s.state = 'active'
             OR NOT EXISTS (SELECT 1 FROM license_store_grants a
                             WHERE a.product = s.product AND a.store = s.store
                               AND a.purchase_key_hash = s.purchase_key_hash
                               AND a.state = 'active')));

INSERT INTO grant_entitlements (product, grant_id, key, value_json, state, updated_at)
SELECT s.product, 'grt_s_' || s.store || '_' || s.purchase_key_hash, s.flag, 'true', 'default',
       s.granted_at
  FROM license_store_grants s
 WHERE s.state = 'active'
    OR NOT EXISTS (SELECT 1 FROM license_store_grants a
                    WHERE a.product = s.product AND a.store = s.store
                      AND a.purchase_key_hash = s.purchase_key_hash AND a.state = 'active')
ON CONFLICT (product, grant_id, key) DO UPDATE SET
  value_json = excluded.value_json,
  state = excluded.state,
  updated_at = excluded.updated_at
WHERE grant_entitlements.value_json IS NOT excluded.value_json
   OR grant_entitlements.state IS NOT excluded.state
   OR grant_entitlements.updated_at IS NOT excluded.updated_at;

-- Each purchase names the grant it made.
UPDATE dist_purchases
   SET grant_id = 'grt_s_' || store || '_' || purchase_key_hash
 WHERE grant_id IS NULL
   AND EXISTS (SELECT 1 FROM grants g
                WHERE g.product = dist_purchases.product
                  AND g.id = 'grt_s_' || dist_purchases.store || '_' || dist_purchases.purchase_key_hash);

-- Each mapping's flag becomes its entitlement row, and while `flag` is the mapping's one key (until
-- LX-11 writes several) a key that is not the flag, or of a mapping that is gone, is dropped.
DELETE FROM dist_store_product_entitlements
 WHERE NOT EXISTS (SELECT 1 FROM dist_store_products m
                    WHERE m.product = dist_store_product_entitlements.product
                      AND m.store = dist_store_product_entitlements.store
                      AND m.store_product_id = dist_store_product_entitlements.store_product_id
                      AND m.flag = dist_store_product_entitlements.key);

INSERT INTO dist_store_product_entitlements (product, store, store_product_id, key, value_json)
SELECT product, store, store_product_id, flag, 'true'
  FROM dist_store_products
 WHERE 1
ON CONFLICT (product, store, store_product_id, key) DO NOTHING;
