-- F-34.4 (P0-49 job `distribution.feed-access-customers`): the ledger of the access rows the job
-- moved, so its `down` restores them exactly. Expand-only: a new table, nothing read by the
-- ladder (`registry/authorize.ts`) and nothing altered.
--
-- One row per row the job changed, keyed (product, ecosystem, deliverable_id):
--   deliverable_id = ''  the feed's own `dist_registry_feeds.access_mode`; `from_feed_mode` is what
--                        it read before the job (`authenticated` or `entitled`); the other prior_*
--                        columns are NULL.
--   deliverable_id = id  a package deliverable's own `dist_access` row, written so the feed's move
--                        to `licensed` admits no one it did not admit before (an entitled feed
--                        gated every package at `entitled`). `had_row` says whether the row
--                        existed; when it did, `prior_mode`, `prior_entitlement` and
--                        `prior_source` hold what the job overwrote (entitlement is never
--                        changed; it is kept for the record). A row the job created is deleted
--                        by `down`.
-- `moved_at` is epoch seconds. Distribution owns the table (`db/owners.ts`). It holds no person,
-- no secret and no account subject.
CREATE TABLE IF NOT EXISTS dist_registry_access_moves (
  product          TEXT NOT NULL REFERENCES products(slug),
  ecosystem        TEXT NOT NULL,
  deliverable_id   TEXT NOT NULL,
  from_feed_mode   TEXT NOT NULL CHECK (from_feed_mode IN ('authenticated', 'entitled')),
  had_row          INTEGER NOT NULL CHECK (had_row IN (0, 1)),
  prior_mode       TEXT CHECK (prior_mode IS NULL OR prior_mode IN ('public', 'authenticated', 'licensed', 'entitled')),
  prior_entitlement TEXT,
  prior_source     TEXT CHECK (prior_source IS NULL OR prior_source IN ('manifest', 'admin')),
  moved_at         INTEGER NOT NULL,
  PRIMARY KEY (product, ecosystem, deliverable_id)
);
