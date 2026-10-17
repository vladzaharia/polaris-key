-- Rollback of 0121_sdk_sightings.sql. The Integration read model loses its Verified facts and the
-- page shows "Not seen yet" until the SDKs are seen again; nothing else reads the table.
DROP INDEX IF EXISTS idx_sdk_sightings_seen;
DROP TABLE IF EXISTS sdk_sightings;
