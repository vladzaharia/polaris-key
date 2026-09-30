-- P2-03 — the deliverable a release belongs to (release_deliverables, 0027_a).
--
-- NOT NULL DEFAULT 'app' backfills every existing row at once: every release in the store today
-- is a release of the product's app. No foreign key: a column addition cannot carry one with a
-- non-NULL default, and the writers (sync, the descriptor ingest) create the deliverable row in
-- the same batch.
--
-- ONE statement per file (see 0013/0020): a bare column addition cannot be made
-- replay-idempotent in pure SQL, so nothing may sit behind it and be stranded by a failed replay.
ALTER TABLE release_metadata ADD COLUMN deliverable_id TEXT NOT NULL DEFAULT 'app';
