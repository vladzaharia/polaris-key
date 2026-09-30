-- P0-02 — `release.ignoreTags`, manifest-owned (written by linkRepo and resync).
--
-- A JSON array of exact tag names that are never a candidate on any moving channel (a pinned
-- X.Y.Z still reaches them). NULL means none.
--
-- ONE statement per file (see 0013/0014): a bare ALTER cannot be made replay-idempotent in
-- pure SQL, so nothing may sit behind it and be stranded by a failed replay.
ALTER TABLE release_config ADD COLUMN ignore_tags_json TEXT;
