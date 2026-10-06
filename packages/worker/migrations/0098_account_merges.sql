-- PX-W12 (PORTAL.md §4.11, §10.2 G27): joining two Polaris Key accounts is undoable for 72 hours.
--
-- One row per join (`mergeAccounts`, I-05), written in the join's own batch. `snapshot_json` is
-- what moved (the absorbed account's row, the survivor's details it filled in, and the ids of the
-- links, passkeys, licences, sessions, pictures, registry tokens, relinks, consents, terms
-- acceptances, auto-attach blocks and pairwise subjects that went over), which is what an undo
-- replays backwards (`accounts/mergeUndo.ts`).
--
-- `survivor_id` and `absorbed_id` are INTERNAL account ids: the global account id never leaves
-- the Worker's Identity and Core code (S-16 §5.1). The snapshot holds the absorbed person's
-- details, so it lives no longer than the window: an undo clears it, the nightly job deletes rows
-- whose window ended, and deleting the survivor deletes its rows.
--
-- An open row (`undone_at IS NULL AND undo_until > now`) also blocks the survivor from being
-- absorbed by a later join, so the undo stays possible for the whole window.
--
-- Owner (TABLE_OWNERS in packages/docs/scripts/gen-reference.mjs): Identity. Expand-only; every
-- statement is `IF NOT EXISTS`, so a replay converges (R11-04).
CREATE TABLE IF NOT EXISTS account_merges (
  id            TEXT PRIMARY KEY,
  survivor_id   TEXT NOT NULL,
  absorbed_id   TEXT NOT NULL,
  merged_at     INTEGER NOT NULL,
  undo_until    INTEGER NOT NULL,
  undone_at     INTEGER,
  snapshot_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_merges_survivor
  ON account_merges(survivor_id, undo_until);
CREATE INDEX IF NOT EXISTS idx_account_merges_window
  ON account_merges(undo_until);
