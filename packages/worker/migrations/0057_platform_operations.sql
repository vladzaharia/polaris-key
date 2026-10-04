-- A-14 (notes/S-13 §7.2): self-reported operations, phase 1. Two Core-owned, product-less tables
-- (`TABLE_OWNERS.core` in the docs generator) that the Worker writes about itself, read by
-- `GET /manage/api/platform/operations`. No Cloudflare token, no outbound call.
--
-- `platform_job_runs` — the cron's outcome, persisted from the `MaintenanceReport` that
-- `handleScheduled` already builds (`src/core/platformOps.ts` `recordJobRun`). One run is a group
-- of rows sharing `run_id`:
--
--   - one summary row, `step = '*'`: the whole tick's start, wall-clock duration and outcome
--     (`failed` when any step failed), `items` = steps run, `error_summary` = how many failed;
--   - one row per step FAMILY that succeeded (`audit:*` covers every product's `audit:<slug>`),
--     `items` = steps folded in, `rows_affected` = their summed counts, `duration_ms` summed;
--   - one row per FAILED step, under its full name (`audit:acme`), with `error_summary` = the
--     caught exception's message truncated to 300 characters. These are the same strings the
--     thrown aggregate already writes to Cloudflare's invocation logs; they carry no request data
--     (THREAT-MODEL "Platform settings and operations").
--
-- `job` is `maintenance` or `connectorPoll`; `cron` the trigger that fired. `started_at` is epoch
-- MILLISECONDS (steps are short). The nightly sweep prunes rows older than 30 days
-- (`JOB_RUN_RETENTION_SECONDS`), by age alone: the table has no product column.
--
-- `platform_heartbeats` — one row per Worker script, upserted: `main` on every cron tick, `deltas`
-- (the lazy-delta consumer, which has no fetch route to probe) after every batch. `at` is epoch
-- seconds; `version_tag` the validated `PKEY_RELEASE_TAG` (A-11) and `cf_version_id` the version
-- metadata binding's id, so a stale script shows; `outcome` a short, truncated label of the last
-- work (`ok`, `failed`, `ack:ready`, ...); `backlog_*` the consumer's queue backlog after its batch
-- (`MessageBatch.metadata.metrics`), NULL for `main`. A row untouched for 30 days is pruned with
-- the job runs (a script that was removed).
CREATE TABLE IF NOT EXISTS platform_job_runs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  job           TEXT NOT NULL,
  cron          TEXT,
  step          TEXT NOT NULL,
  started_at    INTEGER NOT NULL,
  duration_ms   INTEGER,
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'failed')),
  items         INTEGER NOT NULL DEFAULT 1,
  rows_affected INTEGER,
  error_summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_platform_job_runs_started
  ON platform_job_runs(started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_platform_job_runs_run ON platform_job_runs(run_id);
CREATE INDEX IF NOT EXISTS idx_platform_job_runs_summary
  ON platform_job_runs(job, step, started_at DESC);

CREATE TABLE IF NOT EXISTS platform_heartbeats (
  script        TEXT PRIMARY KEY,
  at            INTEGER NOT NULL,
  version_tag   TEXT,
  cf_version_id TEXT,
  outcome       TEXT,
  backlog_count INTEGER,
  backlog_bytes INTEGER,
  oldest_at     INTEGER
);
