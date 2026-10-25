-- ST-31 rollback: the `down` path of migration 0130_b_platform_audit_action_idx.sql.
--
-- WHEN. Any time; only Members' "last sign-in" read uses the index, and it works without it.
--
-- HOW. Run once with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0130_b_platform_audit_action_idx.down.sql
-- It is idempotent.

DROP INDEX IF EXISTS idx_platform_audit_action;
