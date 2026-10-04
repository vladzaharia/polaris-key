-- P6-02 — who wrote `trust_policy_json` (the *_source pattern, 0036's `capabilities_source`):
-- 'default' until a platform admin sets a policy, then 'admin'. Never 'manifest': the policy can
-- only tighten what a device must prove, and that is the operator's decision, not the repo's.
-- One bare ALTER and nothing after it (0018_index_assertion.sql).
ALTER TABLE products ADD COLUMN trust_policy_source TEXT NOT NULL DEFAULT 'default';
