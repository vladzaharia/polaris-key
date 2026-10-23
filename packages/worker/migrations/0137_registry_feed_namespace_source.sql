-- F-34.6: where a feed's namespace came from, so the console can say "From manifest" until an
-- operator saves a namespace. Expand-only: one column with a default; the ladder and ingest read
-- `namespace_json` exactly as before and never read this.
--   'manifest'  provisioned from `.pkey/release` (F-34.2) and not written since
--   'console'   set by an operator (every other row, and every row an operator's namespace save
--               touched)
-- Rows the provisioning wrote before this column existed are the ones its actor still owns.
ALTER TABLE dist_registry_feeds ADD COLUMN namespace_source TEXT NOT NULL DEFAULT 'console'
  CHECK (namespace_source IN ('manifest', 'console'));
UPDATE dist_registry_feeds SET namespace_source = 'manifest'
 WHERE updated_by = 'manifest' AND version = 1;
