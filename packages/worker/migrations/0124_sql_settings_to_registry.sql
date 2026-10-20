-- ST-11 (notes/S-18 §2.2, §4.14.4): the SQL-only settings become registry entries, each moved ONCE.
--
--   lazy_delta_settings.enabled / hot_devices / daily_cap -> product_settings deltas.lazy.enabled /
--                                                            deltas.lazy.hotDevices / deltas.lazy.dailyCap
--   email_product_caps.daily_cap                          -> product_settings email.dailyCap
--   release_config.operator_policy_json                   -> product_settings update.operatorPolicy
--
-- Each value is copied into a `product_settings` row (`source = 'console'`: operator-owned, written
-- by `system`) with ONE audit row (`origin = system`, the same shape `writeSetting()` writes), and
-- the readers switch to the registry in the same release. The old tables and the column stay,
-- unread, for one release (a Worker deployed before this migration still reads them); ST-25 drops
-- them. A value over the new maximum of its entry is clamped to it; a NULL, an unreadable or an empty
-- operator policy is not copied (no row reads as the default).
--
-- Replayable: both inserts are INSERT OR IGNORE (a row the registry already holds, or an audit row
-- this migration already wrote, is left alone), so a second run changes nothing. The audit id is
-- fixed per key, unique per product in the audit primary key.
--
-- Rollback: a pre-ST-11 Worker reads the old tables, which this migration leaves as they were.
--   Remove the copied rows with: DELETE FROM product_settings WHERE updated_by = system
--   and DELETE FROM audit WHERE origin = system AND id LIKE st11:%.

INSERT OR IGNORE INTO product_settings (product, key, value_json, source, version, updated_at, updated_by, reason)
SELECT p, k, v, 'console', 1, t, 'system', 'Moved to the settings registry' FROM (
SELECT product p, 'deltas.lazy.enabled' k, CASE enabled WHEN 1 THEN '"on"' ELSE '"off"' END v, updated_at t FROM lazy_delta_settings
UNION ALL SELECT product, 'deltas.lazy.hotDevices', MIN(hot_devices, 100000), updated_at FROM lazy_delta_settings WHERE hot_devices IS NOT NULL
UNION ALL SELECT product, 'deltas.lazy.dailyCap', MIN(daily_cap, 10000), updated_at FROM lazy_delta_settings WHERE daily_cap IS NOT NULL
UNION ALL SELECT product, 'email.dailyCap', MIN(daily_cap, 1000000), modified_at FROM email_product_caps
UNION ALL SELECT product, 'update.operatorPolicy', operator_policy_json, strftime('%s', 'now') FROM release_config WHERE json_valid(operator_policy_json) AND json_type(operator_policy_json) = 'object' AND operator_policy_json <> '{}'
) WHERE p IN (SELECT slug FROM products);

INSERT OR IGNORE INTO audit (product, id, at, actor_sub, actor_name, action, target_kind, target_id, summary, before_json, after_json, origin, reason, setting_key)
SELECT product, 'st11:' || key, strftime('%s', 'now'), 'system', 'System', 'setting.update', 'setting', key, 'Moved ' || key || ' into the settings registry', json_object('stored', NULL, 'version', 0, 'effective', NULL, 'source', 'default'), json_object('stored', json(value_json), 'version', 1, 'effective', json(value_json), 'source', 'console'), 'system', reason, key
FROM product_settings WHERE updated_by = 'system' AND reason = 'Moved to the settings registry';
