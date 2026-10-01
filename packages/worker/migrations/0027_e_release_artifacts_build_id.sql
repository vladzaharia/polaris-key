-- P2-03 — the build (release_builds.build_id, 0027_a) an artifact is a file of.
--
-- NULL for a legacy release with no descriptor and no artifact map (builds for those are P2-04's).
-- Written by the descriptor ingest; a resync never touches it.
--
-- ONE statement per file (see 0013/0020).
ALTER TABLE release_artifacts ADD COLUMN build_id TEXT;
