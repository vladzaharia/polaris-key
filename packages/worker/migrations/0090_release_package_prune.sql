-- Feed retention (owner request 2026-10-06): when a package version V is published on `stable`,
-- the package's `main`-channel prereleases that sort below it (semver `X-main.N`, PEP 440
-- `X.devN`, with X <= V) are PRUNED: their release rows, files and blob refs are deleted, so the
-- feeds stop listing them and the blob collector (P4-14) reclaims the bytes nothing else holds
-- (`services/release/packages/prune.ts`). Both tables are Release-owned (TABLE_OWNERS.release).
-- Expand-only: new tables no deployed Worker names.
--
-- `release_package_prunes`: one row per pruned version, written in the same D1 batch as the
-- deletion. It is the tombstone that keeps a package version UNIQUE FOREVER after its
-- `release_packages` row is gone (ingest refuses to republish a pruned version, reason
-- `package-version-taken`), and the record of what went, by whom, and how many bytes it freed.
--
--   release_id   `<deliverable>@<version>`, as it was
--   stable       the stable version whose publish (or backfill) pruned it
--   files        how many files the version had; `bytes` their total size, and `freed_bytes` the
--                part no remaining blob ref held (what the collector will reclaim)
--   pruned_by    `system:feed-retention` for the automatic prune, else the admin or CI actor
CREATE TABLE IF NOT EXISTS release_package_prunes (
  product        TEXT NOT NULL REFERENCES products(slug),
  ecosystem      TEXT NOT NULL,
  name_norm      TEXT NOT NULL,
  version        TEXT NOT NULL,
  deliverable_id TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  stable         TEXT NOT NULL,
  files          INTEGER NOT NULL,
  bytes          INTEGER NOT NULL,
  freed_bytes    INTEGER NOT NULL,
  pruned_at      INTEGER NOT NULL,
  pruned_by      TEXT NOT NULL,
  PRIMARY KEY (product, ecosystem, name_norm, version)
);

CREATE INDEX IF NOT EXISTS idx_release_package_prunes_deliverable
  ON release_package_prunes(product, deliverable_id, pruned_at);

-- `release_package_retention`: the product's feed retention setting
-- (`release.packages.prunePrereleases`, the settings registry). No row = the default, OFF: a
-- tenant product opts in. The system product always prunes, whatever its row says.
CREATE TABLE IF NOT EXISTS release_package_retention (
  product           TEXT PRIMARY KEY REFERENCES products(slug),
  prune_prereleases INTEGER NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT,
  CHECK (prune_prereleases IN (0, 1))
);
