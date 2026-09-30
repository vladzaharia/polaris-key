-- P0-02 — `release.stableTagPattern`, manifest-owned (written by linkRepo and resync).
--
-- The anchored regex a tag must match to be a candidate for stable/latest and for the beta
-- prerelease fallback. NULL means the default (a semver tag with an optional leading `v`), so
-- pre-existing rows need no backfill.
--
-- ONE statement per file (see 0013/0014): a bare ALTER cannot be made replay-idempotent in
-- pure SQL, so nothing may sit behind it and be stranded by a failed replay.
ALTER TABLE release_config ADD COLUMN stable_tag_pattern TEXT;
