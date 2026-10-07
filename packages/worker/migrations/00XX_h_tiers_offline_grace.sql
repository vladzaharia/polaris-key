-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.12): the tier default for a licence's offline grace,
-- `max_offline_days` (manifest `licensing.tiers[].policyOfflineGraceDays`). Deliberately not
-- named `max_offline_days`: the tier's manifest `maxOfflineDays` is a legacy alias of
-- `policyExpiryDays`. NULL falls back to the product default. Stored only until LX-09 reads it in
-- `combined` mode; `legacy` documents never read it.
--
-- ONE statement per file (R11-04).
ALTER TABLE tiers ADD COLUMN policy_offline_grace_days INTEGER;
