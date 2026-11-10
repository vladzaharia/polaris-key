-- Rollback of migration 0163_d_identity_refresh_tokens.sql. Only after rolling the Worker back to a
-- build that never names the table. Dropping it ends every refresh token at once: each registered
-- client sends its person through sign-in again. Access tokens already issued expire within 600 s.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0163_d_identity_refresh_tokens.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS identity_refresh_tokens;
