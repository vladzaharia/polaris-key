-- I-12 (S-16 §5.2, §5.4 item 9): the developer's relink tool, with its 72-hour undo.
--
-- Polaris runs no recovery desk. Beyond a person's remaining sign-in methods, recovery is the
-- developer's: the console's Users page can move a licence of its own product to another pairwise
-- subject of that product. Each move is one row here. The row is what makes the move reversible
-- (the undo moves the licence back to `from_account_id` while `undo_until` has not passed and the
-- licence still sits where the relink put it), what the console shows as the relink history, and
-- what the per-operator daily alert counts.
--
-- `from_account_id` and `to_account_id` are INTERNAL: the global account id never leaves the
-- Worker's Identity and Core code (S-16 §5.1). The console reads the subjects only. A merge
-- re-keys the absorbed account's ids to the survivor (so an undo still finds its owner), and an
-- account deletion clears them (the undo of a relink away from a deleted account leaves the
-- licence floating).
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Identity. Expand-only; every
-- statement is `IF NOT EXISTS`, so a replay converges (R11-04).
CREATE TABLE IF NOT EXISTS license_relinks (
  product         TEXT NOT NULL,
  id              TEXT NOT NULL,
  license_id      TEXT NOT NULL,
  from_account_id TEXT,
  to_account_id   TEXT,
  from_subject    TEXT,
  to_subject      TEXT NOT NULL,
  reason          TEXT NOT NULL,
  actor_sub       TEXT NOT NULL,
  actor_name      TEXT,
  notices_sent    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  undo_until      INTEGER NOT NULL,
  undone_at       INTEGER,
  undone_by       TEXT,
  undo_reason     TEXT,
  PRIMARY KEY (product, id)
);
CREATE INDEX IF NOT EXISTS idx_license_relinks_license
  ON license_relinks(product, license_id, created_at);
CREATE INDEX IF NOT EXISTS idx_license_relinks_actor
  ON license_relinks(actor_sub, created_at);
