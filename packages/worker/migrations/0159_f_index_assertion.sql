-- 0143_b_index_assertion.sql's successor: the same deploy-time assertion plus the four
-- subscription indexes (LX-41.2).
--
-- That unique index is what makes `agree_key` unique per product: without it a second device could
-- register a key another device holds and nothing would error. Mechanics are exactly 0018's (read
-- its header): DELETE then INSERT, so a replay reaches the same end state, and a short count aborts
-- the INSERT on `required_indexes_are_missing`. The runtime counterpart is `REQUIRED_INDEXES` in
-- `src/scheduled.ts`; test/surfaces/scheduled.test.ts asserts it names the same set as the NEWEST
-- `*_index_assertion.sql`, which is this file until a later package adds another. The "_f" sorts it
-- after `0158_d_subscriptions.sql`. Provisional number.

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
    ('idx_admin_api_tokens_hash'),
    ('idx_audit_time'),
    ('idx_ci_tokens_jti'),
    ('idx_device_keys_agree'),
    ('idx_devices_license_status'),
    ('idx_devices_seat'),
    ('idx_licenses_email_lower'),
    ('idx_licenses_enroll_hwid'),
    ('idx_licenses_origin'),
    ('idx_licenses_sub'),
    ('idx_licenses_sub_global'),
    ('idx_portal_audit_at'),
    ('idx_portal_audit_product_at'),
    ('idx_product_keys_one_active'),
    ('idx_product_keys_verify'),
    ('idx_release_download_tokens_expiry'),
    ('idx_release_download_tokens_hash'),
    ('idx_release_metadata_seq'),
    ('idx_subscriptions_due'),
    ('idx_subscriptions_grant_live'),
    ('idx_subscriptions_license_live'),
    ('idx_subscriptions_ref'),
    ('idx_tiers_implicit')
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
