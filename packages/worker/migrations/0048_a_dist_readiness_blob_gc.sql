-- P4-14 — outlet readiness holds and the blob collector's bookkeeping, part a (part b:
-- 0048_b_blob_gc_claim.sql). Two CREATE TABLEs, then ONE bare ALTER and nothing after it
-- (0018_index_assertion.sql): SQLite has no `ADD COLUMN IF NOT EXISTS`, so a replay stops at the
-- first ALTER that already ran, and nothing may follow it in its file.
--
-- `dist_readiness` — Distribution's (`TABLE_OWNERS.distribution`). One row per (app release,
-- outlet): whether the app release's REQUIRED pack set is available through the outlet's
-- transport (CONTENT §6.4, README §3.8). The hold itself is computed on read
-- (`services/distribution/readiness.ts`) so a new app release is held from its first request;
-- these rows are the persisted snapshot the console, the matrix and P4-15/P5-08 read, refreshed
-- by Distribution's own triggers (an availability report, the connector cron) and by an operator.
--
--   - `state` is `pending | blocked | ready | overridden`. `pending` = the required set cannot be
--     computed yet (it holds, fail-closed); `blocked` names the first blocking pack release.
--   - `source = 'admin'` is an operator OVERRIDE (`state = 'overridden'`): it releases the hold,
--     is audited, and survives every recompute and resync until the operator clears it.
--   - `detail_json` keeps the computed blockers (and, on a store outlet Polaris Key cannot hold,
--     the warning), recomputed under an override too, so the console still shows what is missing.
CREATE TABLE IF NOT EXISTS dist_readiness (
  product                  TEXT NOT NULL REFERENCES products(slug),
  app_release_id           TEXT NOT NULL,
  outlet_id                TEXT NOT NULL,
  blocking_pack_release_id TEXT,
  state                    TEXT NOT NULL CHECK (state IN ('pending', 'blocked', 'ready', 'overridden')),
  detail_json              TEXT,
  source                   TEXT NOT NULL DEFAULT 'computed' CHECK (source IN ('computed', 'admin')),
  override_reason          TEXT,
  computed_at              INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  updated_by               TEXT NOT NULL,
  PRIMARY KEY (product, app_release_id, outlet_id)
);

-- `blob_gc_log` — Core's (`TABLE_OWNERS.core`). The collector's trail (`core/blobGc.ts`): every
-- ref it dropped (with the product that held it) and every object it deleted, or failed to
-- delete. An object is shared across products, so its deletion belongs to no product's `audit`
-- rows; this is where "who dropped the last ref, and when was the object deleted" is answered.
-- Pruned by the nightly sweep after the audit retention (180 days).
CREATE TABLE IF NOT EXISTS blob_gc_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('ref-dropped', 'deleted', 'delete-failed')),
  storage_key TEXT NOT NULL,
  product     TEXT,
  ref_kind    TEXT,
  ref_id      TEXT,
  size        INTEGER,
  detail      TEXT
);

CREATE INDEX IF NOT EXISTS idx_blob_gc_log_at ON blob_gc_log(at);
CREATE INDEX IF NOT EXISTS idx_blob_gc_log_key ON blob_gc_log(storage_key);

-- When the collector first saw the object with no ref from any product (NULL while referenced).
-- Mark sets it, a new ref (or a re-promote) clears it, and the sweep deletes only objects
-- unreferenced for the grace period AND older than the bucket lock (180 days from `created_at`).
ALTER TABLE blob_objects ADD COLUMN unreferenced_since INTEGER;
