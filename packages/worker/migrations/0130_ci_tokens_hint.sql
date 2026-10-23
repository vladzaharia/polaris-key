-- F-33b.4 (UX review M1): the last four characters of a static CI token, shown beside its label so
-- an operator can match a row to the secret in their CI. NULL for tokens made before this and for
-- GitHub OIDC tokens. A hint reveals 4 of 43 random characters, like registry_tokens.hint. Core
-- owns ci_tokens. Expand-only: a Worker deployed before this migration never names the column.
-- Rollback: scripts/rollback/0130_ci_tokens_hint.down.sql.
ALTER TABLE ci_tokens ADD COLUMN hint TEXT;
