-- An immutable fingerprint baseline. Drift is measured against the first
-- usable fingerprint bound to a device, never against the last one tolerated. A NULL baseline
-- means the next usable fingerprint sets it.
ALTER TABLE device_fingerprints ADD COLUMN baseline_components_json TEXT;
ALTER TABLE device_fingerprints ADD COLUMN baseline_anchor_hash TEXT;
ALTER TABLE device_fingerprints ADD COLUMN baseline_at INTEGER;

-- Backfill from verified rows whose stored map has the anchor and at least 3 components.
UPDATE device_fingerprints
   SET baseline_components_json = components_json,
       baseline_anchor_hash = anchor_hash,
       baseline_at = first_seen
 WHERE status = 'verified'
   AND anchor_hash IS NOT NULL
   AND json_valid(components_json)
   AND json_type(components_json) = 'object'
   AND (SELECT COUNT(*) FROM json_each(components_json)) >= 3;
