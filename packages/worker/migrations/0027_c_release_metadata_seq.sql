-- P2-03 — monotonic publication order per deliverable.
--
-- Publication order, not version order: a backport can carry a higher seq than a newer version.
-- It is what the CI-signed release record carries (README §3.3) and what breaks ties in pack-set
-- resolution. Backfilled in 0027_h; unique per (product, deliverable_id) through
-- idx_release_metadata_seq, which 0027_i asserts. NULL only on a row written by pre-P2-03 code.
--
-- ONE statement per file (see 0013/0020).
ALTER TABLE release_metadata ADD COLUMN seq INTEGER;
