-- I-11 (S-16 §5.5, §5.7): self-service account deletion stays reversible for fourteen days.
--
-- The account stays active while this request exists so its holder can export data and explicitly
-- cancel from the portal. The scheduled sweep starts the existing hard-erasure state machine at
-- `due_at`; the final erasure batch removes this row with every other account row. Identity owns
-- this table (TABLE_OWNERS). The lead assigns the migration number at rebase.
CREATE TABLE IF NOT EXISTS account_deletions (
  account_id   TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  requested_at INTEGER NOT NULL,
  due_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_deletions_due ON account_deletions(due_at);
