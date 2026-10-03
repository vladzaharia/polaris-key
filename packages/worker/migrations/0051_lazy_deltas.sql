-- P4-17 — lazy hot-pair deltas (notes/S-08 §6): install telemetry, the demand it builds, the
-- per-product opt-in, and the deltas the consumer Worker (`src/deltasEntry.ts`) generates.
-- CREATE TABLE and CREATE INDEX only, all IF NOT EXISTS, so the file replays cleanly
-- (0018_index_assertion.sql); none of these indexes is a security invariant, so the assertion
-- list is unchanged.

-- `lazy_delta_settings` — Core's (`core/deltaDemand.ts`). The per-product opt-in: a product with
-- no row, or `enabled = 0`, has no demand counted and no delta generated, whatever the
-- deployment's `LAZY_DELTAS` kill switch says. `hot_devices` and `daily_cap` override the
-- defaults (25 devices, 20 deltas a day) when set. Written by an operator (docs/RUNBOOK.md
-- "Lazy deltas"), read on every report that carries `packInstalls` and by the consumer.
CREATE TABLE IF NOT EXISTS lazy_delta_settings (
  product      TEXT PRIMARY KEY REFERENCES products(slug),
  enabled      INTEGER NOT NULL DEFAULT 0,
  hot_devices  INTEGER,
  daily_cap    INTEGER,
  updated_at   INTEGER NOT NULL,
  CHECK (enabled IN (0, 1)),
  CHECK (hot_devices IS NULL OR hot_devices >= 1),
  CHECK (daily_cap IS NULL OR daily_cap >= 0)
);

-- `delta_demand_devices` — Core's. One row per (product, pack, from, to, device): the latest
-- `packInstalls` entry that device reported for that pair. A device counts once per pair however
-- often it reports (the report is a last-snapshot, `setDeviceReported`). `strategy` is the
-- strategy it installed with: a `delta` install is NOT demand (it already had a delta), but it
-- keeps a generated delta warm. Pruned by the nightly sweep after `DEMAND_RETENTION_SECONDS`.
CREATE TABLE IF NOT EXISTS delta_demand_devices (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  from_sha256     TEXT NOT NULL,
  to_sha256       TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  strategy        TEXT NOT NULL,
  seen_at         INTEGER NOT NULL,
  PRIMARY KEY (product, deliverable_id, from_sha256, to_sha256, device_id)
);

-- The sweep's window scans and the prune, by time.
CREATE INDEX IF NOT EXISTS idx_delta_demand_devices_seen
  ON delta_demand_devices(product, seen_at);

-- "How many devices now sit on payload X" (the installed base an R2 event's new payload is
-- joined with: devices that moved TO X are on X).
CREATE INDEX IF NOT EXISTS idx_delta_demand_devices_to
  ON delta_demand_devices(product, deliverable_id, to_sha256);

-- `delta_demand` — Core's. The nightly aggregate of `delta_demand_devices` over the hot window:
-- distinct devices that moved from → to WITHOUT a delta (`devices`), and the window it covers.
-- Rewritten each night for every enabled product; what P6-03's funnel can read.
CREATE TABLE IF NOT EXISTS delta_demand (
  product         TEXT NOT NULL REFERENCES products(slug),
  deliverable_id  TEXT NOT NULL,
  from_sha256     TEXT NOT NULL,
  to_sha256       TEXT NOT NULL,
  devices         INTEGER NOT NULL,
  window_start    INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  PRIMARY KEY (product, deliverable_id, from_sha256, to_sha256)
);

-- `release_lazy_deltas` — Release's (`services/release/packs/deltas/`). One row per pair the
-- consumer decided: `ready` (the frame is stored at `storage_key` and `descriptor_json` is its
-- `zstd-patch-from` descriptor), `refused` (with `reason`, so a refused pair is not re-encoded
-- every night) or `cold` (its `lazy-delta` blob ref was dropped for P4-14's collector). The
-- primary key is the idempotency key: a duplicate event finds the row and does nothing.
CREATE TABLE IF NOT EXISTS release_lazy_deltas (
  product          TEXT NOT NULL REFERENCES products(slug),
  deliverable_id   TEXT NOT NULL,
  build_id         TEXT NOT NULL,
  from_sha256      TEXT NOT NULL,
  to_sha256        TEXT NOT NULL,
  method           TEXT NOT NULL,
  state            TEXT NOT NULL,
  reason           TEXT,
  storage_key      TEXT,
  artifact_sha256  TEXT,
  artifact_bytes   INTEGER,
  descriptor_json  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (product, from_sha256, to_sha256, method),
  CHECK (state IN ('ready', 'refused', 'cold'))
);

-- The daily cap (deltas a product generated since a time) and the cold scan.
CREATE INDEX IF NOT EXISTS idx_release_lazy_deltas_state
  ON release_lazy_deltas(product, state, created_at);
