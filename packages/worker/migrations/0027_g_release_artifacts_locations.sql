-- P2-03 — where an artifact's bytes can be fetched: a JSON array of hash-pinned locations
-- (R2, GitHub, store, external), each verified against the row's sha256.
--
-- NULL means "GitHub's source_url only", as today. Written by the descriptor ingest; a resync
-- never touches it.
--
-- ONE statement per file (see 0013/0020).
ALTER TABLE release_artifacts ADD COLUMN locations_json TEXT;
