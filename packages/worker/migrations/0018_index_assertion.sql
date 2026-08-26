-- R11-04 — deploy-time assertion that the indexes the code depends on actually exist.
--
-- THE PROBLEM THIS REPLACES. Seven of the original migrations fail on replay with `duplicate
-- column name`, and SQLite has neither `ADD COLUMN IF NOT EXISTS` nor conditional DDL, so a bare
-- `ALTER` can never be made replay-idempotent in pure SQL. The data lane closed the *stranding*
-- risk (idempotent statements first, one ALTER per file with nothing after it,
-- 0012_replay_guard.sql re-asserting the security indexes) and recommended a deploy-time index
-- assertion instead of a doomed rebuild. This is that assertion.
--
-- WHY IT WORKS. Every index below is a correctness or security invariant, not a nicety: a
-- half-applied migration that silently skips one degrades a *constraint* into an *unenforced
-- convention*, and every code path keeps returning 200. `idx_licenses_enroll_hwid` is
-- one-free-licence-per-machine; `idx_devices_seat` is the arbiter that makes seat claiming
-- atomic; `idx_product_keys_one_active` is one active signing key per product;
-- `idx_release_download_tokens_hash` is what makes a download token globally unambiguous. Losing
-- any of them is invisible at runtime and catastrophic in aggregate.
--
-- HOW IT FAILS. `schema_index_assertion.found` must equal `expected`, so a short count aborts
-- the INSERT with `CHECK constraint failed: required_indexes_are_missing` and takes the
-- migration — and therefore the deploy — down with it. It is idempotent: DELETE then INSERT, to
-- the same end state, every replay. The runtime counterpart is `assertRequiredIndexes()` in
-- `src/scheduled.ts`, which re-checks the identical list on every cron tick; a test asserts the
-- two lists are the same set, so they cannot drift.
--
-- TO DIAGNOSE A FAILURE, run this against the database and re-apply the named migration:
--
--   WITH required(name) AS (VALUES ('idx_audit_time'), ...)  -- the list below
--   SELECT r.name FROM required r
--    WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type='index' AND m.name = r.name);

CREATE TABLE IF NOT EXISTS schema_index_assertion (
  id       INTEGER PRIMARY KEY,
  expected INTEGER NOT NULL,
  found    INTEGER NOT NULL,
  missing  TEXT NOT NULL,
  CONSTRAINT required_indexes_are_missing CHECK (found = expected)
);

DELETE FROM schema_index_assertion;

WITH required(name) AS (
  VALUES
    ('idx_audit_time'),
    ('idx_devices_license_status'),
    ('idx_devices_seat'),
    ('idx_licenses_email_lower'),
    ('idx_licenses_enroll_hwid'),
    ('idx_licenses_origin'),
    ('idx_licenses_sub'),
    ('idx_licenses_sub_global'),
    ('idx_portal_account_emails_account'),
    ('idx_portal_account_identities_account'),
    ('idx_portal_audit_at'),
    ('idx_portal_audit_product_at'),
    ('idx_portal_license_links_license'),
    ('idx_product_keys_one_active'),
    ('idx_product_keys_verify'),
    ('idx_release_download_tokens_expiry'),
    ('idx_release_download_tokens_hash')
)
INSERT INTO schema_index_assertion (id, expected, found, missing)
SELECT
  1,
  (SELECT COUNT(*) FROM required),
  (SELECT COUNT(*) FROM required r
    WHERE EXISTS (SELECT 1 FROM sqlite_master m
                   WHERE m.type = 'index' AND m.name = r.name)),
  (SELECT COALESCE(group_concat(r.name, ', '), '')
     FROM required r
    WHERE NOT EXISTS (SELECT 1 FROM sqlite_master m
                       WHERE m.type = 'index' AND m.name = r.name));
