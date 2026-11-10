-- LX-34.2 rollback: the `down` path of migrations 0160_a_tiers_entitlements.sql and
-- 0160_b_license_entitlements.sql.
--
-- WHEN. Only after rolling the Worker back to a build before LX-34.2. That Worker never names the
-- column or the tables, so dropping them loses only the tier entitlement buckets, the entitlement
-- catalog rows and the job ledger. If the job `license.entitlement-buckets` ever ran, undo it
-- FIRST from the console (its `down` restores the licence overrides it rewrote from the ledger);
-- the ledger is the only record of what to undo, so take its rows before dropping it:
--   SELECT * FROM entitlement_bucket_backfill;
-- Licence overrides the job rewrote stay valid for an old Worker either way (the same merged
-- entitlements), so this script does not touch `licenses`.
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0160_entitlement_buckets.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.

DROP TABLE IF EXISTS entitlement_bucket_backfill;
DROP TABLE IF EXISTS license_entitlements;
ALTER TABLE tiers DROP COLUMN entitlements_json;
