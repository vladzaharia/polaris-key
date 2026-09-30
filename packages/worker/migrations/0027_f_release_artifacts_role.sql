-- P2-03 — what an artifact is FOR: payload, files-index, chunk-index, chunk-bundle, delta,
-- signature or checksum (ARTIFACT_ROLES in @polaris-key/manifest; no CHECK, the list grows).
--
-- Backfilled in 0027_h from the legacy name-sniffed `kind`. A resync fills a NULL role from the
-- kind and never overwrites one that is set, so a descriptor's role survives.
--
-- ONE statement per file (see 0013/0020).
ALTER TABLE release_artifacts ADD COLUMN role TEXT;
