-- F-36 feed cleanup on by default: the one-time dry-run NOTICE.
--
-- `release.packages.prunePrereleases` (0090_release_package_prune.sql) is ON by default for every
-- product, and covers the built-in `dev` channel beside `main`. A product that never chose is not
-- pruned the moment this ships: the Release cron first raises ONE notice for it, a dry run of what
-- cleanup would delete, and cleanup starts `starts_at` (a week later). Until then nothing is
-- deleted. A stored choice (`release_package_retention`, on or off) wins at once and needs no
-- notice (`services/release/packages/prune.ts` `pruneRetentionOf`, `noticePruneRetention`).
--
-- Expand-only: a new Release-owned table no deployed Worker names. One row per product, written
-- once (`INSERT … ON CONFLICT DO NOTHING`), never updated.
--
--   noticed_at   when the dry run was taken
--   starts_at    when cleanup turns on for a product that never chose (`noticed_at` + 7 days)
--   packages     packages that had something to delete; `versions` the versions, `bytes` their
--                total size and `freed_bytes` the part no remaining blob ref holds
CREATE TABLE IF NOT EXISTS release_package_retention_notices (
  product     TEXT PRIMARY KEY REFERENCES products(slug),
  noticed_at  INTEGER NOT NULL,
  starts_at   INTEGER NOT NULL,
  packages    INTEGER NOT NULL,
  versions    INTEGER NOT NULL,
  bytes       INTEGER NOT NULL,
  freed_bytes INTEGER NOT NULL
);
