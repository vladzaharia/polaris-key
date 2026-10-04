-- P6-02 — when the device last reached `attested` (epoch seconds); NULL while it never has.
-- One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE devices ADD COLUMN attested_at INTEGER;
