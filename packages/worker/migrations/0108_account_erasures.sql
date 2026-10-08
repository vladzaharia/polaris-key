-- SEC-WP-04 (SEC-PRV-1, SEC-PRV-19): account erasure is a resumable state machine.
--
-- `accounts.status = 'deleted'` (the CHECK already allows it and every reader already treats
-- anything but 'active' as "cannot sign in") is the ERASING state. This table is the progress
-- record: one row per erasure that has not finished. It holds the opaque `acct_...` id and
-- counters only, never an email, name or product. The final erasure batch (the one that removes
-- the account row and writes the id-only tombstone) deletes the row, so an empty table means
-- nothing is half erased; a row that keeps `attempts` climbing is a stuck erasure, which the
-- nightly maintenance step `erasures` reports.
--
--   lease_until      a running attempt owns the erasure until then (request and cron cannot race)
--   next_attempt_at  the retry sweeper's back-off: it only picks rows due at or before its clock
--   failed_step      the hook that failed last (`store:<name>`, `devices`, `licenses`, `avatars`,
--                    `commit`), and `last_error` its error class and message, 200 characters
--
-- Owner: Identity (TABLE_OWNERS). Expand-only: a code rollback leaves the table unread (an
-- erasure the old Worker started has no row; the new Worker's sweeper adopts every
-- `status = 'deleted'` account that lacks one).
CREATE TABLE IF NOT EXISTS account_erasures (
  account_id      TEXT PRIMARY KEY,
  requested_at    INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  next_attempt_at INTEGER NOT NULL,
  lease_until     INTEGER NOT NULL DEFAULT 0,
  failed_step     TEXT,
  last_error      TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_erasures_next
  ON account_erasures(next_attempt_at);
