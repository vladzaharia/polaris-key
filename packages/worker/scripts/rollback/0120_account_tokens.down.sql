-- Rollback of 0120_account_tokens.sql. Personal tokens stop authenticating; the registry host
-- falls back to the credentials it knew before (`pkeyr_`, `pkeyci_`). Nothing else reads the table.
DROP INDEX IF EXISTS idx_account_tokens_account;
DROP INDEX IF EXISTS idx_account_tokens_hash;
DROP TABLE IF EXISTS account_tokens;
