-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.7): the tier a `base` store product mints its licence
-- on. NULL for every mapping today (all `addon`).
--
-- ONE statement per file (R11-04).
ALTER TABLE dist_store_products ADD COLUMN base_tier_id TEXT;
