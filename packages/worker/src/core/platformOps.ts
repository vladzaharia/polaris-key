/**
 * Self-reported operations (A-14, notes/S-13 §7.2, phase 1): what the Worker records about its
 * own background work, and the small readers the Operations page needs. No Cloudflare token and
 * no outbound call: everything here is a D1 row the Worker wrote, or a binding it already holds.
 *
 *   - `recordJobRun`     persists one cron tick's `MaintenanceReport` into `platform_job_runs`
 *                        (`scheduled.ts` `handleScheduled`);
 *   - `writeHeartbeat`   upserts a script's `platform_heartbeats` row: `main` on every cron tick,
 *                        `deltas` after every consumer batch (`deltasEntry.ts`);
 *   - `pruneJobRuns` / `pruneHeartbeats`  the nightly sweep's 30-day retention.
 *
 * Kept lean on purpose: the lazy-delta consumer bundles this module, so it imports nothing but
 * types. Error text is truncated (`ERROR_SUMMARY_MAX`) and only ever a caught exception's message
 * or a step name: the R12 "never log a secret" posture already keeps those secret-free, and no
 * request data reaches a cron step (THREAT-MODEL "Platform settings and operations").
 */

import type { Db, DbStatement } from "../db/types.js";

/** How long a job-run row (and a heartbeat nobody refreshed) is kept: 30 days. */
export const JOB_RUN_RETENTION_SECONDS = 30 * 24 * 60 * 60;
/** A stored error message is cut to this many characters. */
export const ERROR_SUMMARY_MAX = 300;
/** The summary row's `step`: the whole tick. */
export const RUN_SUMMARY_STEP = "*";

/** The two cron jobs `handleScheduled` dispatches to. */
export type JobName = "maintenance" | "connectorPoll";

/** One step's timing, in epoch milliseconds. */
export interface StepTiming {
  startedAt: number;
  durationMs: number;
}

/** The shape `scheduled.ts` builds (its `MaintenanceReport`, with timings). */
export interface JobReport {
  counts: Record<string, number>;
  failures: Record<string, string>;
  timings?: Record<string, StepTiming>;
}

/** Cut `text` to `ERROR_SUMMARY_MAX` characters, marking the cut. */
export function truncateSummary(text: string, max = ERROR_SUMMARY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `audit:acme` → `audit`; a name without a colon is its own family. */
export function stepFamily(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(0, i);
}

interface JobRunRow {
  id: string;
  step: string;
  started_at: number;
  duration_ms: number | null;
  outcome: "ok" | "failed";
  items: number;
  rows_affected: number | null;
  error_summary: string | null;
}

/**
 * The rows one tick becomes (see `migrations/0056_platform_operations.sql`): a `*` summary, one
 * row per successful step family (per-product steps folded together, so a run stays about a dozen
 * rows however many products there are), and one row per failed step under its full name.
 */
export function jobRunRows(
  runId: string,
  startedAtMs: number,
  endedAtMs: number,
  report: JobReport,
): JobRunRow[] {
  const timings = report.timings ?? {};
  const failed = Object.entries(report.failures);
  const okNames = Object.keys(report.counts).filter(
    (name) => !(name in report.failures),
  );
  const families = new Map<
    string,
    { started: number; duration: number; items: number; rows: number }
  >();
  for (const name of okNames) {
    const family = `${stepFamily(name)}${name.includes(":") ? ":*" : ""}`;
    const t = timings[name];
    const f = families.get(family) ?? {
      started: t?.startedAt ?? startedAtMs,
      duration: 0,
      items: 0,
      rows: 0,
    };
    f.started = Math.min(f.started, t?.startedAt ?? f.started);
    f.duration += t?.durationMs ?? 0;
    f.items += 1;
    f.rows += report.counts[name] ?? 0;
    families.set(family, f);
  }
  let n = 0;
  const id = () => `${runId}:${String(n++).padStart(4, "0")}`;
  const rows: JobRunRow[] = [
    {
      id: id(),
      step: RUN_SUMMARY_STEP,
      started_at: startedAtMs,
      duration_ms: Math.max(0, endedAtMs - startedAtMs),
      outcome: failed.length > 0 ? "failed" : "ok",
      items: okNames.length + failed.length,
      rows_affected: null,
      error_summary:
        failed.length > 0 ? `${failed.length} step(s) failed` : null,
    },
  ];
  for (const [step, f] of [...families].sort(([a], [b]) => a.localeCompare(b)))
    rows.push({
      id: id(),
      step,
      started_at: f.started,
      duration_ms: f.duration,
      outcome: "ok",
      items: f.items,
      rows_affected: f.rows,
      error_summary: null,
    });
  for (const [step, message] of failed.sort(([a], [b]) => a.localeCompare(b)))
    rows.push({
      id: id(),
      step: truncateSummary(step, 200),
      started_at: timings[step]?.startedAt ?? startedAtMs,
      duration_ms: timings[step]?.durationMs ?? null,
      outcome: "failed",
      items: 1,
      rows_affected: null,
      error_summary: truncateSummary(message),
    });
  return rows;
}

/** D1 binds at most 100 parameters per statement: 9 columns × 10 rows stays under it. */
const ROWS_PER_INSERT = 10;

/** Persist one tick. Callers treat a throw here as a failure of the recording, not the job. */
export async function recordJobRun(
  db: Db,
  opts: {
    runId: string;
    job: JobName;
    cron: string | null;
    startedAtMs: number;
    endedAtMs: number;
    report: JobReport;
  },
): Promise<number> {
  const rows = jobRunRows(
    opts.runId,
    opts.startedAtMs,
    opts.endedAtMs,
    opts.report,
  );
  const statements: DbStatement[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    statements.push({
      sql: `INSERT OR IGNORE INTO platform_job_runs
              (id, run_id, job, cron, step, started_at, duration_ms, outcome, items,
               rows_affected, error_summary)
            VALUES ${chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ")}`,
      params: chunk.flatMap((r) => [
        r.id,
        opts.runId,
        opts.job,
        opts.cron,
        r.step,
        r.started_at,
        r.duration_ms,
        r.outcome,
        r.items,
        r.rows_affected,
        r.error_summary,
      ]),
    });
  }
  await db.batch(statements);
  return rows.length;
}

/** A release tag as `deploy.yml` accepts it (its "Select target" step); `deployIdentity` uses it too. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** The bits of either script's env a heartbeat reads. */
export interface HeartbeatEnv {
  PKEY_RELEASE_TAG?: string;
  CF_VERSION_METADATA?: { id?: string } | WorkerVersionMetadata;
}

export interface Heartbeat {
  script: "main" | "deltas";
  at: number;
  outcome: string;
  backlog?: {
    backlogCount?: number;
    backlogBytes?: number;
    oldestMessageTimestamp?: Date;
  } | null;
}

/** Upsert `script`'s heartbeat row. */
export async function writeHeartbeat(
  db: Db,
  env: HeartbeatEnv,
  beat: Heartbeat,
): Promise<void> {
  const tag = env.PKEY_RELEASE_TAG?.trim() ?? "";
  const versionId = env.CF_VERSION_METADATA?.id;
  const b = beat.backlog;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
  const oldest =
    b?.oldestMessageTimestamp instanceof Date &&
    !Number.isNaN(b.oldestMessageTimestamp.getTime())
      ? Math.floor(b.oldestMessageTimestamp.getTime() / 1000)
      : null;
  await db.run(
    `INSERT INTO platform_heartbeats
       (script, at, version_tag, cf_version_id, outcome, backlog_count, backlog_bytes, oldest_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(script) DO UPDATE SET
       at = excluded.at, version_tag = excluded.version_tag,
       cf_version_id = excluded.cf_version_id, outcome = excluded.outcome,
       backlog_count = excluded.backlog_count, backlog_bytes = excluded.backlog_bytes,
       oldest_at = excluded.oldest_at`,
    beat.script,
    beat.at,
    RELEASE_TAG.test(tag) ? tag : null,
    typeof versionId === "string" && versionId ? versionId.slice(0, 64) : null,
    truncateSummary(beat.outcome, 120),
    num(b?.backlogCount),
    num(b?.backlogBytes),
    oldest,
  );
}

/** Delete job-run rows started before `cutoff` (epoch seconds), at most `limit` per call. */
export async function pruneJobRuns(
  db: Db,
  cutoff: number,
  limit: number,
): Promise<number> {
  return db.runChanges(
    `DELETE FROM platform_job_runs
      WHERE rowid IN (SELECT rowid FROM platform_job_runs WHERE started_at < ? LIMIT ?)`,
    cutoff * 1000,
    limit,
  );
}

/** Delete heartbeats no script refreshed since `cutoff` (epoch seconds): a removed script. */
export async function pruneHeartbeats(db: Db, cutoff: number): Promise<number> {
  return db.runChanges("DELETE FROM platform_heartbeats WHERE at < ?", cutoff);
}
