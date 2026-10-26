-- Device-key floors: what a device's keys have reached, kept after the keys themselves are deleted.
--
--   key_seq  the highest `device_keys.key_seq` the device has held. A device that is deauthorized
--            and registers again continues from here, so a `keySeq` only ever increases.
--   pop_at   the `issuedAt` of the last accepted keys proof. A proof must be strictly newer, so a
--            captured request cannot be replayed inside its skew window.
--
-- Written only by `core/devices/keys.ts`, in the same batch as the `device_keys` write. Deleted with
-- the device row (licence delete) and with the product, never on deauthorize (`purgeDeviceData`
-- leaves it, which is the point). Public
-- values only. Owned by core (TABLE_OWNERS). No foreign keys, no cascades (R11-01). Expand-only: a
-- Worker built before this migration never names the table. Rollback:
-- scripts/rollback/0144_device_key_floor.down.sql.
CREATE TABLE IF NOT EXISTS device_key_floor (
  product   TEXT NOT NULL,
  device_id TEXT NOT NULL,
  key_seq   INTEGER NOT NULL,
  pop_at    INTEGER,
  PRIMARY KEY (product, device_id)
);
