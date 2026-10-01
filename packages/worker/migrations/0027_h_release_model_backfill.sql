-- P2-03 — backfill the release model's new columns, then the indexes that depend on them.
--
-- Idempotent throughout, so a replay after a failure anywhere in 0027_b..g converges:
--   * every UPDATE touches only rows whose column is still NULL;
--   * the indexes are DROP/CREATE ... IF [NOT] EXISTS.
-- It sits AFTER the column additions it fills (the 0022_d precedent) because it cannot run before
-- them; nothing in it can be stranded by them, since each of those files is a single statement.

-- 1. `seq`: publication order per (product, deliverable), numbered in (published_at, release_id)
--    order. A row that already has a seq keeps it; the rest continue after the deliverable's
--    current maximum, so the sequence stays gap-free on a replay too. MATERIALIZED makes both
--    CTEs complete before the first row changes (the maximum must not move under the UPDATE).
WITH top AS MATERIALIZED (
  SELECT product, deliverable_id, COALESCE(MAX(seq), 0) AS top_seq
    FROM release_metadata
   GROUP BY product, deliverable_id
),
numbered AS MATERIALIZED (
  SELECT m.product AS product,
         m.release_id AS release_id,
         t.top_seq + ROW_NUMBER() OVER (
           PARTITION BY m.product, m.deliverable_id
           ORDER BY m.published_at, m.release_id
         ) AS seq
    FROM release_metadata m
    JOIN top t ON t.product = m.product AND t.deliverable_id = m.deliverable_id
   WHERE m.seq IS NULL
)
UPDATE release_metadata
   SET seq = numbered.seq
  FROM numbered
 WHERE release_metadata.product = numbered.product
   AND release_metadata.release_id = numbered.release_id
   AND release_metadata.seq IS NULL;

-- 2. `role` from the legacy name-sniffed `kind`: sidecars keep their meaning, everything else a
--    sync ever recorded is something a consumer downloads.
UPDATE release_artifacts
   SET role = CASE kind
                WHEN 'signature' THEN 'signature'
                WHEN 'checksum' THEN 'checksum'
                ELSE 'payload'
              END
 WHERE role IS NULL;

-- 3. P0-02 made idx_release_metadata_version non-unique (two tags may strip to one version, 0023).
--    Widen it to the deliverable, still non-unique: every version lookup is now per deliverable.
DROP INDEX IF EXISTS idx_release_metadata_version;
CREATE INDEX IF NOT EXISTS idx_release_metadata_version
  ON release_metadata(product, deliverable_id, version);

-- 4. Two releases of one deliverable can never share a seq (two deliverables can). A correctness
--    invariant, so 0027_i and src/scheduled.ts assert it exists. NULL seqs (a row written by
--    pre-P2-03 code) are distinct to a UNIQUE index, and the next sync fills them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_metadata_seq
  ON release_metadata(product, deliverable_id, seq);

-- 5. "Which artifact is this hash" — the descriptor's digest cross-check and the blob route.
CREATE INDEX IF NOT EXISTS idx_release_artifacts_sha256
  ON release_artifacts(product, sha256)
  WHERE sha256 IS NOT NULL;
