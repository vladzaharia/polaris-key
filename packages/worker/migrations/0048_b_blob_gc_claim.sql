-- P4-14 — the blob collector's bookkeeping, part b (part a: 0048_a_dist_readiness_blob_gc.sql).
-- One index on part a's column, then ONE bare ALTER and nothing after it (see part a).

-- The sweep's candidate scan and the mark phase's reset both read by `unreferenced_since`.
CREATE INDEX IF NOT EXISTS idx_blob_objects_unreferenced ON blob_objects(unreferenced_since);

-- The sweep's CLAIM: set (conditionally, in one statement: unreferenced past the grace period,
-- older than the lock, no ref) before the R2 delete and cleared only by the row's deletion or a
-- failed delete. `promote` refuses to re-record a claimed object (`core/blobs.ts`
-- `recordObject`), so a concurrent publish can never earn a ref to bytes being deleted.
ALTER TABLE blob_objects ADD COLUMN gc_claimed_at INTEGER;
