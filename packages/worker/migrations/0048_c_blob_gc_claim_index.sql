-- P4-14 — the blob collector's bookkeeping, part c (parts a and b: 0048_a_dist_readiness_blob_gc.sql,
-- 0048_b_blob_gc_claim.sql). No ALTER: a replay is a no-op (`IF NOT EXISTS`). Its own file because
-- the index names part b's column, and part b's ALTER must stay its last statement.

-- The sweep reads its claims (`gc_claimed_at = ?`, and the stale-claim pass `gc_claimed_at < ?`);
-- almost every row is unclaimed, so a partial index over the claimed few keeps both reads tiny.
CREATE INDEX IF NOT EXISTS idx_blob_objects_claimed ON blob_objects(gc_claimed_at)
  WHERE gc_claimed_at IS NOT NULL;
