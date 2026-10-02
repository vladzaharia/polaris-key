-- P4-02 — pack deliverables, part b (part a: 0045_a_pack_deliverables.sql). One bare ALTER and
-- nothing after it (0018_index_assertion.sql): SQLite has no `ADD COLUMN IF NOT EXISTS`, so a
-- replay stops at the first ALTER that already ran, and nothing may follow it in its file.

-- A build's `embeds` (the packs it ships embedded), as a JSON array of pack ids; NULL when the
-- descriptor omits it.
ALTER TABLE release_builds ADD COLUMN embeds_json TEXT;
