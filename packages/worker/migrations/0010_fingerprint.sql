-- Polaris Key — hardware fingerprints and software facts.
-- Additive only. A device's identity stays `devices.device_id` (the stable primary key every
-- existing row and signed doc is bound to); the fingerprint is a SEPARATE, server-evaluated
-- signal, so adopting it can never orphan an existing device.
--
-- Component values arrive already hashed on-device (`pkey-hw:<product>:<component>:<raw>`), so
-- no raw hardware serial is ever stored here. Both tables are deleted with their device row —
-- retention is device lifetime, enforced inline (see repo.setDeviceStatus), not by a cron.

PRAGMA foreign_keys = ON;

-- Current hardware fingerprint per device. Exactly one row per device: history is deliberately
-- NOT kept — drift is recorded as an `audit` event instead, which is where forensics belong.
CREATE TABLE IF NOT EXISTS device_fingerprints (
  product          TEXT NOT NULL REFERENCES products(slug),
  device_id        TEXT NOT NULL,
  -- Composite digest over the components actually read (base64url, 32 chars). Coarse dedupe
  -- key only; component-wise comparison is the authority.
  hwid             TEXT NOT NULL,
  -- { "<component>": "<hash>", ... } — absent components are omitted, never placeheld.
  components_json  TEXT NOT NULL,
  -- The machineUuid component hash, denormalised so anchor matching is an indexed lookup.
  anchor_hash      TEXT,
  status           TEXT NOT NULL DEFAULT 'verified',  -- verified | unverified
  first_seen       INTEGER NOT NULL,
  last_seen        INTEGER NOT NULL,
  last_drift_at    INTEGER,
  last_drift_count INTEGER,
  PRIMARY KEY (product, device_id),
  CHECK (status IN ('verified', 'unverified'))
);

-- Free-tier enrolment dedupe and admin lookup both resolve a device from an hwid.
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_hwid
  ON device_fingerprints(product, hwid);

-- Anchor lookup finds a drifted device whose machineUuid still matches.
CREATE INDEX IF NOT EXISTS idx_device_fingerprints_anchor
  ON device_fingerprints(product, anchor_hash)
  WHERE anchor_hash IS NOT NULL;

-- Current software snapshot per device. Overwritten on every report; no history.
CREATE TABLE IF NOT EXISTS device_facts (
  product         TEXT NOT NULL REFERENCES products(slug),
  device_id       TEXT NOT NULL,
  os_name         TEXT,
  os_version      TEXT,
  os_build        TEXT,
  kernel          TEXT,
  cpu_model       TEXT,
  cpu_cores       INTEGER,
  ram_mb          INTEGER,
  machine_model   TEXT,
  locale          TEXT,
  timezone        TEXT,
  runtime_name    TEXT,
  runtime_version TEXT,
  -- { "<probeId>": { "present": bool, "version"?: string } } — product-declared probes only.
  probes_json     TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (product, device_id)
);

-- Per-tier enforcement strength. NULL inherits the product default.
ALTER TABLE tiers ADD COLUMN policy_fingerprint TEXT;

-- { enabled, defaultMode, probes: [{ id, label, macos?, windows?, linux? }] }
-- Follows the existing branding_json / artifact_policy_json JSON-column precedent.
ALTER TABLE products ADD COLUMN fingerprint_policy_json TEXT;

-- 'manifest' => .pkey/product owns this policy and resync reapplies it.
-- 'admin'    => an operator edited it live; resync must leave it alone.
ALTER TABLE products ADD COLUMN fingerprint_policy_source TEXT NOT NULL DEFAULT 'manifest';
