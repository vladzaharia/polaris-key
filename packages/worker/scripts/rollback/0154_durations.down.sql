-- Report-only rollback of migrations 0154_a..0159_f (LX-41.1 duration columns, LX-41.2 subscriptions).
--
-- WHEN. After rolling the Worker back to a build that does not read `on_expiry` or
-- `fallback_version`. This script changes nothing: LX-41 moves no data, and the columns, the
-- `subscriptions` table, triggers and indexes stay for a roll-forward (the 0105_licensing.down.sql precedent).
--
-- HOW. Run with
--   wrangler d1 execute <DATABASE> --env <ENV> --remote --file scripts/rollback/0154_durations.down.sql

-- 1. Licences an old Worker would refuse: a lapsed `keepVersion` licence gets 401 instead of
--    keeping its version until the roll-forward.
SELECT l.product, l.id, l.on_expiry, l.expires_at, l.fallback_version
FROM licenses l LEFT JOIN tiers t ON t.product = l.product AND t.id = l.tier_id
WHERE l.expires_at IS NOT NULL AND l.expires_at <= CAST(strftime('%s', 'now') AS INTEGER)
  AND COALESCE(l.on_expiry, t.on_expiry) IS NOT NULL
  AND COALESCE(l.on_expiry, t.on_expiry) <> 'stop';

-- 2. Licences with `fallback_version` set that are not lapsed (an old Worker moved the expiry
--    without clearing it): clear these before the roll-forward.
SELECT product, id, expires_at, fallback_version
FROM licenses
WHERE fallback_version IS NOT NULL
  AND (expires_at IS NULL OR expires_at > CAST(strftime('%s', 'now') AS INTEGER));
