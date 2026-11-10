-- LX-35.1 rollback: the `down` path of migrations 0161_a_addons.sql, 0161_b_grants_addon_id.sql
-- and 0161_c_index_assertion.sql.
--
-- WHEN. Only after rolling the Worker back to a build before LX-35.1. That Worker never names the
-- column, the index or the tables, so dropping them loses only the add-on definitions, the grants'
-- add-on references and the job ledger. If the job `license.addons-backfill` ever ran, undo it
-- FIRST from the console (its `down` clears the `addon_id` values it set and deletes the add-ons
-- it created, from the ledger); the ledger is the only record of what to undo, so take its rows
-- before dropping it:
--   SELECT * FROM addon_backfill;
--
-- 0105_licensing.down.sql IS INVALID AFTER LX-35. It copies the `oidc` grants' keys back into the
-- licences' overrides and empties those grants; after LX-35 a grant's keys come from its add-on
-- (`grants.addon_id`, read live), which that script does not know, so an old Worker would serve a
-- grant it cannot read. Undo LX-35 (the backfill job, then this script) before it, or restore the
-- keys onto the licences by hand (P0-24's ladder records this).
--
-- HOW. Run once against the database with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0161_addons.down.sql
-- It is not idempotent: a second run fails with "no such column", changing nothing.
--
-- The index assertion (0161_c) has no down of its own: its row in `schema_index_assertion` is
-- replaced by the next deploy, which re-runs the newest assertion file; a Worker from before
-- LX-35.1 ships 0159_f, whose list has no idx_grants_addon.

DROP TABLE IF EXISTS addon_backfill;
DROP TABLE IF EXISTS addons;
DROP INDEX IF EXISTS idx_grants_addon;
ALTER TABLE grants DROP COLUMN addon_id;
