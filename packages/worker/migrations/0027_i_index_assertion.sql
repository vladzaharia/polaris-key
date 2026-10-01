-- P2-03 — 0018_index_assertion.sql's successor: the same deploy-time assertion, with one more
-- required index.
--
-- `idx_release_metadata_seq` (0027_h) is what makes "two releases of one deliverable never share
-- a seq" a constraint instead of a convention. The signed release record carries seq and pack-set
-- resolution breaks ties by it, so a half-applied 0027 that silently skipped the index would let
-- two releases claim one position and every code path would keep returning 200.
--
-- Mechanics are exactly 0018's (read its header): DELETE then INSERT, so a replay reaches the same
-- end state, and a short count aborts the INSERT on `required_indexes_are_missing`, taking the
-- migration — and the deploy — down with it. The runtime counterpart is `REQUIRED_INDEXES` in
-- `src/scheduled.ts`; test/scheduled.test.ts asserts it names the same set as the NEWEST
-- `*_index_assertion.sql`, which is this file until a later package adds another.

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
    ('idx_release_download_tokens_hash'),
    ('idx_release_metadata_seq')
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
