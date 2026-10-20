-- ST-11 (notes/S-18 §2.2, §4.14.4): the SQL-only settings become registry entries, each moved ONCE.
--
--   lazy_delta_settings.enabled / hot_devices / daily_cap -> product_settings deltas.lazy.enabled /
--                                                            deltas.lazy.hotDevices / deltas.lazy.dailyCap
--   email_product_caps.daily_cap                          -> product_settings email.dailyCap
--   release_config.operator_policy_json                   -> product_settings update.operatorPolicy
--
-- Each value is copied into a `product_settings` row (`source = 'console'`: operator-owned, written
-- by `system`) with ONE audit row (`origin = 'system'`, the same shape `writeSetting()` writes), and
-- the readers switch to the registry in the same release. The old tables and the column stay,
-- unread, for one release (a Worker deployed before this migration still reads them); ST-25 drops
-- them. A value over its entry's new maximum is clamped to it; a NULL, an unreadable or an empty
-- operator policy is not copied (no row reads as the default).
--
-- Replayable: both inserts are INSERT OR IGNORE (a row the registry already holds, or an audit row
-- this migration already wrote, is left alone), so a second run changes nothing. The audit id is
-- fixed per (key), which is unique per product in the audit table's primary key.
--
-- Rollback: a pre-ST-11 Worker reads the old tables, which this migration leaves as they were.
-- To remove the rows anyway:
--   DELETE FROM product_settings WHERE updated_by = 'system' AND key IN
--     ('deltas.lazy.enabled','deltas.lazy.hotDevices','deltas.lazy.dailyCap','email.dailyCap','update.operatorPolicy');
--   DELETE FROM audit WHERE origin = 'system' AND id LIKE 'st11:%';

-- deltas.lazy.enabled
INSERT OR IGNORE INTO product_settings
  (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT product, 'deltas.lazy.enabled', CASE enabled WHEN 1 THEN '"on"' ELSE '"off"' END, 'console', 1, updated_at, 'system', 'Moved to the settings registry'
  FROM lazy_delta_settings
 WHERE 1=1
   AND EXISTS (SELECT 1 FROM products WHERE slug = lazy_delta_settings.product);

INSERT OR IGNORE INTO audit
  (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
   before_json, after_json, origin, reason, setting_key)
SELECT ps.product, 'st11:deltas.lazy.enabled', CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', NULL,
       'setting.update', 'setting', 'deltas.lazy.enabled',
       'Moved deltas.lazy.enabled into the settings registry',
       '{"stored":null,"version":0,"effective":null,"source":"default"}',
       '{"stored":' || ps.value_json || ',"version":1,"effective":' || ps.value_json || ',"source":"console"}',
       'system', 'Moved to the settings registry', 'deltas.lazy.enabled'
  FROM product_settings ps
 WHERE ps.key = 'deltas.lazy.enabled' AND ps.updated_by = 'system' AND ps.version = 1;

-- deltas.lazy.hotDevices
INSERT OR IGNORE INTO product_settings
  (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT product, 'deltas.lazy.hotDevices', CAST(MIN(hot_devices, 100000) AS TEXT), 'console', 1, updated_at, 'system', 'Moved to the settings registry'
  FROM lazy_delta_settings
 WHERE hot_devices IS NOT NULL
   AND EXISTS (SELECT 1 FROM products WHERE slug = lazy_delta_settings.product);

INSERT OR IGNORE INTO audit
  (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
   before_json, after_json, origin, reason, setting_key)
SELECT ps.product, 'st11:deltas.lazy.hotDevices', CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', NULL,
       'setting.update', 'setting', 'deltas.lazy.hotDevices',
       'Moved deltas.lazy.hotDevices into the settings registry',
       '{"stored":null,"version":0,"effective":null,"source":"default"}',
       '{"stored":' || ps.value_json || ',"version":1,"effective":' || ps.value_json || ',"source":"console"}',
       'system', 'Moved to the settings registry', 'deltas.lazy.hotDevices'
  FROM product_settings ps
 WHERE ps.key = 'deltas.lazy.hotDevices' AND ps.updated_by = 'system' AND ps.version = 1;

-- deltas.lazy.dailyCap
INSERT OR IGNORE INTO product_settings
  (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT product, 'deltas.lazy.dailyCap', CAST(MIN(daily_cap, 10000) AS TEXT), 'console', 1, updated_at, 'system', 'Moved to the settings registry'
  FROM lazy_delta_settings
 WHERE daily_cap IS NOT NULL
   AND EXISTS (SELECT 1 FROM products WHERE slug = lazy_delta_settings.product);

INSERT OR IGNORE INTO audit
  (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
   before_json, after_json, origin, reason, setting_key)
SELECT ps.product, 'st11:deltas.lazy.dailyCap', CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', NULL,
       'setting.update', 'setting', 'deltas.lazy.dailyCap',
       'Moved deltas.lazy.dailyCap into the settings registry',
       '{"stored":null,"version":0,"effective":null,"source":"default"}',
       '{"stored":' || ps.value_json || ',"version":1,"effective":' || ps.value_json || ',"source":"console"}',
       'system', 'Moved to the settings registry', 'deltas.lazy.dailyCap'
  FROM product_settings ps
 WHERE ps.key = 'deltas.lazy.dailyCap' AND ps.updated_by = 'system' AND ps.version = 1;

-- email.dailyCap
INSERT OR IGNORE INTO product_settings
  (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT product, 'email.dailyCap', CAST(MIN(daily_cap, 1000000) AS TEXT), 'console', 1, modified_at, 'system', 'Moved to the settings registry'
  FROM email_product_caps
 WHERE daily_cap IS NOT NULL
   AND EXISTS (SELECT 1 FROM products WHERE slug = email_product_caps.product);

INSERT OR IGNORE INTO audit
  (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
   before_json, after_json, origin, reason, setting_key)
SELECT ps.product, 'st11:email.dailyCap', CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', NULL,
       'setting.update', 'setting', 'email.dailyCap',
       'Moved email.dailyCap into the settings registry',
       '{"stored":null,"version":0,"effective":null,"source":"default"}',
       '{"stored":' || ps.value_json || ',"version":1,"effective":' || ps.value_json || ',"source":"console"}',
       'system', 'Moved to the settings registry', 'email.dailyCap'
  FROM product_settings ps
 WHERE ps.key = 'email.dailyCap' AND ps.updated_by = 'system' AND ps.version = 1;

-- update.operatorPolicy
INSERT OR IGNORE INTO product_settings
  (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT product, 'update.operatorPolicy', operator_policy_json, 'console', 1, CAST(strftime('%s', 'now') AS INTEGER), 'system', 'Moved to the settings registry'
  FROM release_config
 WHERE operator_policy_json IS NOT NULL AND json_valid(operator_policy_json) AND json_type(operator_policy_json) = 'object' AND operator_policy_json <> '{}'
   AND EXISTS (SELECT 1 FROM products WHERE slug = release_config.product);

INSERT OR IGNORE INTO audit
  (product, id, at, actor_sub, actor_name, actor_email, action, target_kind, target_id, summary,
   before_json, after_json, origin, reason, setting_key)
SELECT ps.product, 'st11:update.operatorPolicy', CAST(strftime('%s', 'now') AS INTEGER), 'system', 'System', NULL,
       'setting.update', 'setting', 'update.operatorPolicy',
       'Moved update.operatorPolicy into the settings registry',
       '{"stored":null,"version":0,"effective":null,"source":"default"}',
       '{"stored":' || ps.value_json || ',"version":1,"effective":' || ps.value_json || ',"source":"console"}',
       'system', 'Moved to the settings registry', 'update.operatorPolicy'
  FROM product_settings ps
 WHERE ps.key = 'update.operatorPolicy' AND ps.updated_by = 'system' AND ps.version = 1;
