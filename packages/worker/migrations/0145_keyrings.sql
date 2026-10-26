-- U-36.1 (plans/CC-01-cloud-sync.md, D1 tables; WIRE-CONTRACT-V5 §13.11): Core's key ring for
-- Cloud Sync's end-to-end data. The server holds only what it cannot open: HPKE wraps of the root
-- to each device's agreement key, a sealed recovery blob, and sealed adoption blobs. No key that
-- opens any of them is ever stored (rule 7; THREAT-MODEL T11, T21-T23).
--
--   keyrings         one ring per (product, subject). `epoch` >= 1. `state` is 'active'.
--                    `recovery_ct` is the sealed recovery blob (NULL until set); `recovery_at` is
--                    when it last changed. `previous_*` name the ring a reset replaced; its rows
--                    are removed once `previous_until` passes. `created_by` is the creating device.
--   keyring_wraps    a root wrapped to one device, per (ring, epoch). Create-only. Dropped with the
--                    device (core/keyring/store.ts, on the device lifecycle event) and with the ring.
--   keyring_adopted  a foreign or previous root sealed under the current one (`K_adopt`). `ct` is
--                    NULL for a merge candidate nobody has sealed yet.
--
-- Owned by core (TABLE_OWNERS), written only by core/keyring/store.ts, and claimed by the subject
-- store `core.keyring` (merge, delete, export). No foreign keys and no cascades (R11-01).
-- Expand-only: a Worker built before this migration never names the tables.
-- Rollback: scripts/rollback/0145_keyrings.down.sql.
CREATE TABLE IF NOT EXISTS keyrings (
  product          TEXT NOT NULL,
  subject          TEXT NOT NULL,
  ring_id          TEXT NOT NULL,
  epoch            INTEGER NOT NULL DEFAULT 1,
  root_kid         TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'active',
  recovery_ct      TEXT,
  recovery_at      INTEGER,
  previous_ring_id TEXT,
  previous_kid     TEXT,
  previous_until   INTEGER,
  created_by       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (product, subject)
);

CREATE TABLE IF NOT EXISTS keyring_wraps (
  product    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  ring_id    TEXT NOT NULL,
  epoch      INTEGER NOT NULL,
  kid        TEXT NOT NULL,
  kem        TEXT NOT NULL,
  enc        TEXT NOT NULL,
  ct         TEXT NOT NULL,
  by_device  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, subject, device_id, ring_id, epoch)
);
CREATE INDEX IF NOT EXISTS idx_keyring_wraps_device ON keyring_wraps(product, device_id);

CREATE TABLE IF NOT EXISTS keyring_adopted (
  product    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  ring_id    TEXT NOT NULL,
  epoch      INTEGER NOT NULL,
  kid        TEXT NOT NULL,
  ct         TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (product, subject, ring_id, epoch)
);
