-- LX-41.1: what a licence of this tier does when it lapses. NULL = `stop` (today's rule). The
-- vocabulary is checked by 0157_e_duration_vocabulary.sql. Nothing reads it yet. Provisional number;
-- the lead numbers it at merge. Rollback: scripts/rollback/0154_durations.down.sql (report-only).
ALTER TABLE tiers ADD COLUMN on_expiry TEXT;
