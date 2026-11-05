-- LX-41.1: the version a lapsed `keepVersion` licence keeps. NULL = not frozen; '' = nothing to
-- keep. Nothing reads it yet. Provisional number. Rollback: scripts/rollback/0154_durations.down.sql
-- (report-only).
ALTER TABLE licenses ADD COLUMN fallback_version TEXT;
