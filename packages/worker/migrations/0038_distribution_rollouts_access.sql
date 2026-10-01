-- P2b-04 — outlet-scoped rollouts and halts, and delivery access (README §3.8, §3.9).
--
-- Both tables are Distribution's (`TABLE_OWNERS.distribution` in the docs generator).
--
-- `dist_rollouts` — one row per (deliverable, outlet, channel): which release is rolling out
-- there, to how much of the fleet, and in what state. Written by the rollout controls in
-- `services/distribution/rollouts.ts` (console and CI, one implementation) and never by an ingest.
--
--   - `rollout_bp` is basis points, 0–10000. The bucket is evaluated ON THE DEVICE,
--     `u32(sha256(salt ‖ installId)[0..4]) mod 10000` (README §3.6), so the feed stays identical
--     for everyone; the Worker never evaluates it.
--   - `rollout_salt` is 16 random bytes (hex), fresh for every new `release_id`, so the same
--     devices are not always first.
--   - `state` is `active | paused | halted | complete`. The transitions are enforced in code
--     (`TRANSITIONS` in rollouts.ts); the CHECK only keeps a garbage value out.
--   - `mirrored = 1` rows belong to a store connector (P5-02/P5-03) and refuse direct edits.
--   - `source` is who last wrote the row: `admin`, `ci`, a connector kind (`asc`, `play`,
--     `ms-store`) or `auto-halt` (P6-03). Free text by design: the connector packages name their
--     own values.
--
-- `dist_access` — delivery gating per deliverable, the successor to Release's
-- `release_config.artifacts_access` (README §3.5: "today's access modes move here").
--
--   - `mode` includes `entitled`. Unlike the truth store's `release_artifacts.access` CHECK,
--     which never admitted it (0007), an `entitled` value survives here.
--   - `entitlement` is reserved for a named entitlement a gated deliverable requires (paid packs,
--     P4-05 / commerce). Stored and shown; nothing enforces it yet.
--   - `source` is `manifest` (a resync re-applies `.pkey/release` `access.artifacts` through
--     Distribution's `manifestIngest`) or `admin` (an operator claimed it; the ingest skips it).
--   - A deliverable with no row inherits the `app` row; a product with no `app` row is `public`,
--     the default the column it replaces always had.
--
-- The backfill copies every product's `release_config.artifacts_access` into an `app` row, with
-- the owner from P0-01's `access_source`. The value is normalised exactly as `readAccessMode`
-- reads it (anything unrecognised is `public`), so a garbage column reads the same before and
-- after. `INSERT OR IGNORE` keeps a replay from overwriting a row written since.
--
-- The `release_config.artifacts_access` column stays (dropping it needs a table rebuild); no code
-- reads it after this migration.

CREATE TABLE IF NOT EXISTS dist_rollouts (
  product        TEXT NOT NULL REFERENCES products(slug),
  deliverable_id TEXT NOT NULL,
  outlet_id      TEXT NOT NULL,
  channel        TEXT NOT NULL,
  release_id     TEXT NOT NULL,
  rollout_bp     INTEGER NOT NULL CHECK (rollout_bp BETWEEN 0 AND 10000),
  rollout_salt   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('active', 'paused', 'halted', 'complete')),
  mirrored       INTEGER NOT NULL DEFAULT 0 CHECK (mirrored IN (0, 1)),
  source         TEXT NOT NULL,
  started_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  updated_by     TEXT NOT NULL,
  PRIMARY KEY (product, deliverable_id, outlet_id, channel)
);

CREATE TABLE IF NOT EXISTS dist_access (
  product        TEXT NOT NULL REFERENCES products(slug),
  deliverable_id TEXT NOT NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('public', 'authenticated', 'licensed', 'entitled')),
  entitlement    TEXT,
  source         TEXT NOT NULL DEFAULT 'manifest' CHECK (source IN ('manifest', 'admin')),
  modified_at    INTEGER NOT NULL,
  PRIMARY KEY (product, deliverable_id)
);

INSERT OR IGNORE INTO dist_access (product, deliverable_id, mode, entitlement, source, modified_at)
SELECT product,
       'app',
       CASE
         WHEN artifacts_access IN ('authenticated', 'licensed', 'entitled') THEN artifacts_access
         ELSE 'public'
       END,
       NULL,
       CASE WHEN access_source = 'admin' THEN 'admin' ELSE 'manifest' END,
       CAST(strftime('%s', 'now') AS INTEGER)
  FROM release_config;
