-- LX-41.1: the `on_expiry` vocabulary (NULL, `stop`, `keepVersion`, or `tier:<id>` up to 69 bytes)
-- as replaceable triggers (the 0105_m precedent), and the index the lapse job will scan. Replay-safe.
-- Provisional number. Rollback: scripts/rollback/0154_durations.down.sql (report-only).
CREATE TRIGGER IF NOT EXISTS trg_tiers_on_expiry_ins
BEFORE INSERT ON tiers
WHEN NEW.on_expiry IS NOT NULL AND NOT (NEW.on_expiry IN ('stop', 'keepVersion')
  OR (NEW.on_expiry GLOB 'tier:?*' AND length(CAST(NEW.on_expiry AS BLOB)) <= 69))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: tiers.on_expiry'); END;

CREATE TRIGGER IF NOT EXISTS trg_tiers_on_expiry_upd
BEFORE UPDATE OF on_expiry ON tiers
WHEN NEW.on_expiry IS NOT NULL AND NOT (NEW.on_expiry IN ('stop', 'keepVersion')
  OR (NEW.on_expiry GLOB 'tier:?*' AND length(CAST(NEW.on_expiry AS BLOB)) <= 69))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: tiers.on_expiry'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_on_expiry_ins
BEFORE INSERT ON licenses
WHEN NEW.on_expiry IS NOT NULL AND NOT (NEW.on_expiry IN ('stop', 'keepVersion')
  OR (NEW.on_expiry GLOB 'tier:?*' AND length(CAST(NEW.on_expiry AS BLOB)) <= 69))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.on_expiry'); END;

CREATE TRIGGER IF NOT EXISTS trg_licenses_on_expiry_upd
BEFORE UPDATE OF on_expiry ON licenses
WHEN NEW.on_expiry IS NOT NULL AND NOT (NEW.on_expiry IN ('stop', 'keepVersion')
  OR (NEW.on_expiry GLOB 'tier:?*' AND length(CAST(NEW.on_expiry AS BLOB)) <= 69))
BEGIN SELECT RAISE(ABORT, 'CHECK constraint failed: licenses.on_expiry'); END;

CREATE INDEX IF NOT EXISTS idx_licenses_duration_due ON licenses(product, expires_at)
  WHERE on_expiry IS NOT NULL AND on_expiry <> 'stop';
