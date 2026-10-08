-- LX-08 (plans/LX-01.md §6.1): the grant a verified store purchase made (`grt_s_<store>_<hash>`).
-- Added, not renamed: `license_id` stays and keeps being written until LX-16. Filled by the
-- backfill (0105_m) and dual-written by Distribution's `recordPurchase` from then on. NULL for a
-- purchase that granted nothing (pending, rejected).
--
-- ONE statement per file (R11-04).
ALTER TABLE dist_purchases ADD COLUMN grant_id TEXT;
