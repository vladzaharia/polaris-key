-- LX-41.1: the licence's own lapse behaviour, overriding its tier's. NULL inherits. Nothing reads
-- it yet. Provisional number. Rollback: scripts/rollback/0154_durations.down.sql (report-only).
ALTER TABLE licenses ADD COLUMN on_expiry TEXT;
