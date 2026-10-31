-- A device key string is held once per product, in either role (the Worker refuses a repeat). The
-- check looks a signing key up across devices, so it gets an index; `agree_key` already has a
-- unique one. Non-unique on purpose: a row written before the check may already repeat a key.
-- Numbered 0153 at integration (0151 file bytes, 0152 restore keys). Owned by `core` (TABLE_OWNERS:
-- device_keys already is). Expand-only. Rollback: scripts/rollback/0153_device_keys_sign_key_index.down.sql.
CREATE INDEX IF NOT EXISTS idx_device_keys_sign ON device_keys (product, sign_key);
