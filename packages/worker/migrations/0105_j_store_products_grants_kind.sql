-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.7): what a mapped store product grants. `addon`
-- (every mapping today) adds entitlements as a grant; `base` mints a licence (with
-- `base_tier_id`); `seats` adds a seat pack to the claiming device's anchor. Only `addon` is
-- written before LX-11.
--
-- ONE statement per file (R11-04).
ALTER TABLE dist_store_products ADD COLUMN grants_kind TEXT NOT NULL DEFAULT 'addon' CHECK (grants_kind IN ('addon', 'base', 'seats'));
