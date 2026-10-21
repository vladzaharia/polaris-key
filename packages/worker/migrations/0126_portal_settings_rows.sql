-- ST-14 (notes/S-18 §4.10, §4.14.4): the Polaris Locker switches become settings rows, and the
-- Locker reads its branding from one store.
--
--   portal_product_settings.portal_enabled        -> product_settings portal.enabled
--   portal_product_settings.key_reissue_enabled   -> product_settings portal.keyReissue
--   portal_product_settings.claim_by_key          -> product_settings identity.keyEntry.claimByKey
--   products.branding_json                        -> portal_product_settings.branding_json
--
-- Each switch is copied ONCE, and only where it differs from its default (portal on, key reissue
-- off, claim by key off), because no row reads as the default. A copied value is an operator
-- value (`source = 'console'`, written by `system`) with ONE audit row (`origin = system`, the
-- shape `writeSetting()` writes), except claimByKey on a product that follows its repository's
-- manifest and has no claim row: there the value can only have come from the manifest, so its row
-- is `source = 'manifest'` and the next resync reconciles it. A claimByKey the console set already
-- has a claim row with no value (the column held it): that row gains the value.
--
-- Branding keeps the portal row's value; `products.branding_json` (never written by a release of
-- the Worker, NULL in production) is folded in only where the portal row holds none. The portal
-- row is created for it when needed; its other columns take their defaults.
--
-- The switch columns stay, unread, for one release (a Worker deployed before this migration still
-- reads them). ST-25 drops them with the table. `products.branding_json` stays too.
--
-- Replayable: every insert is INSERT OR IGNORE and the updates only fill a NULL, so a second run
-- changes nothing and never clobbers an edit made since. A branding the operator cleared after the
-- first run is filled again from `products.branding_json` only if that column holds one, which no
-- release writes.
--
-- Rollback: a pre-ST-14 Worker reads the old columns, which this migration leaves as they were.
--   Remove the copied rows with: DELETE FROM product_settings WHERE updated_by = 'system'
--   AND reason = 'Moved to the settings registry (Polaris Locker)' and
--   DELETE FROM audit WHERE origin = 'system' AND id LIKE 'st14:%'.

INSERT OR IGNORE INTO portal_product_settings (product, created_at, modified_at)
SELECT slug, CAST(strftime('%s', 'now') AS INTEGER), CAST(strftime('%s', 'now') AS INTEGER)
  FROM products
 WHERE branding_json IS NOT NULL AND json_valid(branding_json)
   AND json_type(branding_json) = 'object' AND branding_json <> '{}';

UPDATE portal_product_settings
   SET branding_json = (SELECT p.branding_json FROM products p WHERE p.slug = portal_product_settings.product)
 WHERE branding_json IS NULL
   AND product IN (SELECT slug FROM products
                    WHERE branding_json IS NOT NULL AND json_valid(branding_json)
                      AND json_type(branding_json) = 'object' AND branding_json <> '{}');

UPDATE product_settings
   SET value_json = COALESCE(
         (SELECT CASE s.claim_by_key WHEN 1 THEN 'true' ELSE 'false' END
            FROM portal_product_settings s WHERE s.product = product_settings.product),
         'false')
 WHERE key = 'identity.keyEntry.claimByKey' AND value_json IS NULL;

INSERT OR IGNORE INTO product_settings (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT s.product, 'portal.enabled', 'false', 'console', 1, s.modified_at, 'system', 'Moved to the settings registry (Polaris Locker)'
  FROM portal_product_settings s
 WHERE s.portal_enabled = 0 AND s.product IN (SELECT slug FROM products);

INSERT OR IGNORE INTO product_settings (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT s.product, 'portal.keyReissue', 'true', 'console', 1, s.modified_at, 'system', 'Moved to the settings registry (Polaris Locker)'
  FROM portal_product_settings s
 WHERE s.key_reissue_enabled = 1 AND s.product IN (SELECT slug FROM products);

INSERT OR IGNORE INTO product_settings (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT s.product, 'identity.keyEntry.claimByKey', 'true',
       CASE WHEN p.release_source = 'github' OR p.system = 1 THEN 'manifest' ELSE 'console' END,
       1, s.modified_at, 'system', 'Moved to the settings registry (Polaris Locker)'
  FROM portal_product_settings s
  JOIN products p ON p.slug = s.product
 WHERE s.claim_by_key = 1;

INSERT OR IGNORE INTO audit (product, id, at, actor_sub, actor_name, action, target_kind, target_id, summary, before_json, after_json, origin, reason, setting_key)
SELECT product, 'st14:' || key, CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', 'setting.update', 'setting', key, 'Moved ' || key || ' into the settings registry', json_object('stored', NULL, 'version', 0, 'effective', NULL, 'source', 'default'), json_object('stored', json(value_json), 'version', 1, 'effective', json(value_json), 'source', source), 'system', reason, key
FROM product_settings WHERE updated_by = 'system' AND reason = 'Moved to the settings registry (Polaris Locker)';
