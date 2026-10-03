-- P4-20 — the content-interface fingerprint: the SHA-256 of an app release's content-interface
-- registry (the content ids and path prefixes its code references), sent by
-- `pkey release publish --content-interface` beside the descriptor. Unsigned release metadata,
-- never a record member: the CLI compares it with the channel's current app release and warns
-- (fails with --strict) when it changed while contentApi did not. NULL for a release published
-- without one. One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE release_metadata ADD COLUMN content_interface TEXT;
