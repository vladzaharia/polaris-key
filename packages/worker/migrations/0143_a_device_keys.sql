-- CC-03.1 (plans/CC-01-cloud-connect.md §2.8): a device's two public keys, registered against its
-- `devices` row. `sign_key` is the raw Ed25519 key a device proves possession with; `agree_key` is
-- the raw X25519 key peers and Cloud Sync wrap to. Both are canonical base64url of 32 bytes, held
-- as given and checked by `core/devices/keys.ts` before they are written (never trusted from the
-- caller). Public keys only: a private key never leaves the device.
--
--   key_seq     1 on first registration; +1 each time either key changes (a rotation). A peer or a
--               sync wrap that names an older `key_seq` is stale.
--   created_at  first registration; rotated_at is the last change (NULL until the first rotation).
--
-- `agree_key` is unique per product (`idx_device_keys_agree`): two devices never share a key
-- agreement key, so a wrap addressed to one reaches only it. Owned by core (TABLE_OWNERS), written
-- only by `core/devices/keys.ts`, and deleted with the device (`purgeDeviceData`, licence delete).
-- No foreign keys and no cascades (R11-01). Expand-only: a Worker built before this migration never
-- names the table. Rollback: scripts/rollback/0143_a_device_keys.down.sql.
CREATE TABLE IF NOT EXISTS device_keys (
  product    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  sign_key   TEXT NOT NULL,
  agree_key  TEXT NOT NULL,
  key_seq    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  PRIMARY KEY (product, device_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_keys_agree ON device_keys(product, agree_key);
