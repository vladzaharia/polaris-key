-- LX-35.1: the add-on a grant belongs to (D35-1).
--
-- `grants.addon_id` - the add-on (`addons.id`, same product) the grant instantiates. NULLABLE in
-- release N: the job `license.addons-backfill` (LX-35.6) sets it on every existing grant and
-- `grantAddOn` (LX-35.4) on every new one; release N+1 adds a trigger that refuses NULL
-- (LX-35.10), which avoids rebuilding a table other tables reference. No FK: the column is the
-- reference, the add-on store refuses to delete an add-on a grant holds. Nothing reads or writes
-- the column yet. `idx_grants_addon` is the "who holds this add-on" read (LX-35.8 holders).
-- Provisional number; the lead numbers it at merge. Rollback: scripts/rollback/0161_addons.down.sql.
ALTER TABLE grants ADD COLUMN addon_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_grants_addon
  ON grants(product, addon_id) WHERE addon_id IS NOT NULL;
