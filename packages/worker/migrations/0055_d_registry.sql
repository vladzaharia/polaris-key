-- F-03 (plans/F-01.md §6.4, §6.5): the package-feed settings (Distribution's) and the render
-- queue (Core's). Idempotent statements only.
--
-- `dist_registry_owners` — Distribution's. The operator-owned `packageFeeds` sub-capability of one
-- owner (product): `enabled = 1` lets its feeds answer on `pkg.plrs.im`. Never written by a
-- manifest; toggled through `PUT /manage/api/products/:slug/distribution/package-feeds`
-- (`expectedVersion`, audited `distribution.package_feeds.update`) and set by the system-product
-- bootstrap. Turning it off stops every read for that owner at once.
CREATE TABLE IF NOT EXISTS dist_registry_owners (
  product     TEXT PRIMARY KEY REFERENCES products(slug),
  enabled     INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- `dist_registry_feeds` — Distribution's. One feed per (owner, ecosystem). `namespace_json` is the
-- dependency-confusion rule ingest enforces (npm {scope}; swift {scope}; maven {groupPrefixes[]};
-- pypi {prefixes[], names[]}; oci {}; godot {publisher}); a feed cannot be enabled with an empty
-- one. `upstream` is pinned to 'none' (no proxying, ever, without a schema change). `ext_json`
-- holds the per-ecosystem extensions (PyPI {htmlFallback}, Swift {requireSigned}, OCI
-- {retainUntaggedDays}, Godot {categoryId, supportLevel}, every ecosystem {yankHidesFromIndex}).
CREATE TABLE IF NOT EXISTS dist_registry_feeds (
  product            TEXT NOT NULL REFERENCES products(slug),
  ecosystem          TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  access_mode        TEXT NOT NULL DEFAULT 'public'
                       CHECK (access_mode IN ('public', 'authenticated', 'licensed', 'entitled')),
  namespace_json     TEXT NOT NULL,
  max_package_bytes  INTEGER NOT NULL,
  upstream           TEXT NOT NULL DEFAULT 'none' CHECK (upstream = 'none'),
  claims_json        TEXT NOT NULL DEFAULT '[]',
  ext_json           TEXT NOT NULL DEFAULT '{}',
  version            INTEGER NOT NULL DEFAULT 1,
  updated_at         INTEGER NOT NULL,
  updated_by         TEXT,
  PRIMARY KEY (product, ecosystem)
);

-- `dist_registry_policy` — Distribution's. The platform's per-ecosystem kill switch and size
-- ceiling, above every owner's own `max_package_bytes`.
CREATE TABLE IF NOT EXISTS dist_registry_policy (
  ecosystem                  TEXT PRIMARY KEY,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  max_package_bytes_ceiling  INTEGER NOT NULL,
  version                    INTEGER NOT NULL DEFAULT 1,
  updated_at                 INTEGER NOT NULL,
  updated_by                 TEXT
);

-- Seeded with S-12 §8.4's defaults: 50 MiB per package, 5 GiB per OCI blob. A replay is a no-op.
INSERT INTO dist_registry_policy (ecosystem, enabled, max_package_bytes_ceiling, updated_at)
VALUES ('npm', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER)),
       ('pypi', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER)),
       ('swift', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER)),
       ('maven', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER)),
       ('oci', 1, 5368709120, CAST(strftime('%s', 'now') AS INTEGER)),
       ('godot', 1, 52428800, CAST(strftime('%s', 'now') AS INTEGER))
ON CONFLICT(ecosystem) DO NOTHING;

-- `registry_render_queue` — Core's (plans/F-01.md §6.5, decision Q3). Release cannot call
-- Distribution (rule 6) and the descriptor hooks are read-only, so a publish, yank, unyank,
-- deprecate or channel move of a package release enqueues here IN THE SAME D1 BATCH
-- (`core/registryQueue.ts` `enqueuePackageRender`), and so do Distribution's settings writes and
-- `packageFeeds` toggles. The composition root drains it (after a request that enqueued, and on
-- every cron run) into Distribution's materialiser.
--
-- One row per (owner, deliverable): the queue COALESCES, since a render reads the package's whole
-- current state. An enqueue on an existing row bumps `generation`; a drain remembers the
-- generation it read and, only after every object is written, deletes the row if the generation
-- is still that one — so an enqueue that lands during a render is never lost, and a crash leaves
-- the row queued for the next drain. `deliverable_id` '*' means every package of the owner (a
-- full render). Keyed product-first like every tenant table (R11-05).
CREATE TABLE IF NOT EXISTS registry_render_queue (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  reason          TEXT NOT NULL,
  enqueued_at     INTEGER NOT NULL,
  generation      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (product, deliverable_id)
);
