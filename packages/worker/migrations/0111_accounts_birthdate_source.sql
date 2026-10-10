-- I-33 (plans/I-27.md §2.4, §6): where `accounts.birthdate` came from: `user` (typed or changed
-- by the person) or `connection:<id>` (a connection's claim the person accepted unchanged in
-- FinishStep). NULL exactly when `birthdate` is NULL. Identity owns the table.
--
-- Expand only: the Worker deployed before I-33 never names it. Rollback:
-- scripts/rollback/0111_accounts_birthdate_source.down.sql.
--
-- ONE statement per file (R11-04).
ALTER TABLE accounts ADD COLUMN birthdate_source TEXT;
