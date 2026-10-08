-- LX-08 (plans/LX-01.md §6.1, notes/S-19 §7.2): a tier's rank, higher is better. It orders anchor
-- choice (LX-10), `license.tier` among contributing licences (LX-09), the OIDC group-map choice
-- (the highest-rank mapped tier wins; ties keep today's first-match order) and
-- `syncTierOnSignIn: upgradeOnly`. Every tier starts at 0, so nothing orders differently until an
-- operator or a manifest (`licensing.tiers[].rank`) sets one. No backfill is needed.
--
-- ONE statement per file (R11-04).
ALTER TABLE tiers ADD COLUMN rank INTEGER NOT NULL DEFAULT 0;
