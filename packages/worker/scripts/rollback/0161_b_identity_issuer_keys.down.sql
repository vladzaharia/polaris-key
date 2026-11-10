-- Rollback of migration 0161_b_identity_issuer_keys.sql. Only after rolling the Worker back to a
-- build that never names the table. It holds the sealed issuer private keys: dropping it destroys
-- them, so every issuer token already issued stops verifying once the JWKS goes (they expire within
-- 600 s anyway) and the next issuer build mints fresh keys.
-- Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0161_b_identity_issuer_keys.down.sql
-- It is idempotent.

DROP TABLE IF EXISTS identity_issuer_keys;
