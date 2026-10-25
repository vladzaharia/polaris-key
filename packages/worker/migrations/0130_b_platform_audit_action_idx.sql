-- ST-31 slice 1: "last console sign-in" on Members reads platform_audit by action and actor.
-- ST-28 plan §5.1 assigned this index to ST-30, which never added it. Owner: core. Expand-only
-- and replay-safe. The lead renumbers 0129 at merge.
-- Rollback: scripts/rollback/0130_b_platform_audit_action_idx.down.sql.
CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit(action, actor_sub, at DESC);
