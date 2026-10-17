-- P0-49: the data-migration runner's record (`core/migrate/`). One row per run of a job:
--
--   mode        'dry-run' (planned, nothing written), 'apply' (written, unit by unit) or 'down'
--               (the job's down path over the units an apply finished);
--   status      'reported' (a dry run's report), 'running' (an apply or down with units left),
--               'applied' / 'reverted' (every unit done), 'failed' (a unit threw: it is retried
--               by the next call);
--   source_id   an apply's dry run, a down's apply (the report an operator read, pinned);
--   changes     rows a dry run would change, or an apply / down changed;
--   lease_until the epoch second a running call holds the run until (a killed call is resumed
--               once it passes); lease_token names the call that holds it: every write a call
--               makes to the run is conditional on its token, so a call whose lease lapsed and
--               was taken over writes nothing more;
--   report_json the totals, with no secret material.
--
-- Expand-only: new tables. Append-only; never pruned. Core owns both (`TABLE_OWNERS.core`).
-- The `CREATE TABLE` keeps one column per line and closes on its own line: the docs data-model
-- generator parses this file literally.

CREATE TABLE IF NOT EXISTS data_migration_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  source_id TEXT,
  requested_by TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  lease_until INTEGER,
  lease_token TEXT,
  changes INTEGER NOT NULL DEFAULT 0,
  report_json TEXT,
  CHECK (mode IN ('dry-run', 'apply', 'down'))
);

CREATE INDEX IF NOT EXISTS idx_data_migration_runs_job
  ON data_migration_runs(job, started_at DESC);

CREATE TABLE IF NOT EXISTS data_migration_units (
  run_id TEXT NOT NULL,
  unit TEXT NOT NULL,
  status TEXT NOT NULL,
  planned INTEGER NOT NULL DEFAULT 0,
  changes INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  error TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (run_id, unit),
  CHECK (status IN ('pending', 'done', 'failed'))
);

-- One apply per report and one down per apply, whatever races: a second first-call hits this.
CREATE UNIQUE INDEX IF NOT EXISTS idx_data_migration_runs_source
  ON data_migration_runs(source_id, mode) WHERE source_id IS NOT NULL;
