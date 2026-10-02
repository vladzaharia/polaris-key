-- P4-12 — pack sets, part b (part a: 0046_a_pack_sets.sql). One bare ALTER and nothing after it
-- (0018_index_assertion.sql): SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay stops at the
-- first ALTER that already ran, and nothing may follow it in its file.

-- A pack variant's signed `conflicts` (the pack ids it cannot share a set with), as a JSON array;
-- NULL when the record omits it. Its `requires` (engine, contentApi, packs) is `requires_json`.
ALTER TABLE release_builds ADD COLUMN conflicts_json TEXT;
