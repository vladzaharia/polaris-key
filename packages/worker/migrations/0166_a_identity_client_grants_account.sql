-- I-21.15 (plans/I-34-I-21.15.md §3): the client grants of one account, read by account: the
-- Connected apps list, erasure and a merge. The primary key leads with `product`, so none of those
-- reads can use it. Provisional number; the lead assigns the real one at merge.
-- Expand-only. Rollback: scripts/rollback/0166_a_identity_client_grants_account.down.sql.
CREATE INDEX IF NOT EXISTS identity_client_grants_account
  ON identity_client_grants (account_id);
