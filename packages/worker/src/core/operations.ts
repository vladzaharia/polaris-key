/**
 * The Operations snapshot (A-14, notes/S-13 §7.2 phase 1), served by the platform-admin
 * `GET /manage/api/platform/operations` (`admin/handlers/platform.ts`). Everything is
 * self-reported: binding probes, the queues' own `metrics()`, the rows the cron and the consumer
 * write about themselves (`core/platformOps.ts`), D1's `meta.size_after`, `blob_objects` totals,
 * the required-index check and the connector tables. No Cloudflare token, no outbound call.
 *
 * Every probe is bounded (`PROBE_TIMEOUT_MS`) and fault-isolated: one binding that hangs or throws
 * reads as `ok: false` with a truncated message, and the rest of the snapshot still renders.
 * Nothing in it is secret: presence is a boolean, never an id; error text is truncated and comes
 * from a caught exception (THREAT-MODEL "Platform settings and operations").
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { RUN_SUMMARY_STEP, truncateSummary } from "./platformOps.js";

/** A probe that has not answered after this long reads as failed. */
export const PROBE_TIMEOUT_MS = 3000;
/** A fixed key no writer uses: the KV and R2 probes read it and expect nothing. */
export const PROBE_KEY = "ops/probe/absent";
/** How many recent runs, failures and refusal reasons the snapshot carries. */
export const RECENT_RUNS = 10;
export const RECENT_FAILURES = 20;
/** The consumer's queue settings (`wrangler.deltas.toml`), shown as facts. */
export const DELTA_CONSUMER_CONFIG = {
  maxBatchSize: 1,
  maxBatchTimeoutSeconds: 5,
  maxRetries: 3,
  maxConcurrency: 1,
} as const;
/** The store connectors Distribution ships (P5-02..P5-04). */
export const CONNECTORS = ["asc", "play", "ms-store"] as const;

export interface Probe {
  bound: boolean;
  ok: boolean | null;
  latencyMs: number | null;
  error?: string;
}

export interface QueueStatus extends Probe {
  backlogCount: number | null;
  backlogBytes: number | null;
  oldestMessageAt: number | null;
}

function errorText(e: unknown): string {
  return truncateSummary(e instanceof Error ? e.message : String(e), 200);
}

async function timed<T>(
  run: () => Promise<T>,
): Promise<{ value?: T; ms: number; error?: string }> {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer in ${PROBE_TIMEOUT_MS} ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { value, ms: Date.now() - started };
  } catch (e) {
    return { ms: Date.now() - started, error: errorText(e) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function probeOf(r: { ms: number; error?: string }): Probe {
  return r.error === undefined
    ? { bound: true, ok: true, latencyMs: r.ms }
    : { bound: true, ok: false, latencyMs: r.ms, error: r.error };
}

const UNBOUND: Probe = { bound: false, ok: null, latencyMs: null };

/**
 * D1: `SELECT 1` through the raw binding, whose result's `meta.size_after` is the database size
 * in bytes. Without a raw binding (the Node test lane) the probe goes through `db` and the size
 * is unknown.
 */
async function probeD1(
  env: Env,
  db: Db,
): Promise<{ probe: Probe; sizeBytes: number | null }> {
  const raw = env.DB as D1Database | undefined;
  if (raw && typeof raw.prepare === "function") {
    const r = await timed(() => raw.prepare("SELECT 1 AS ok").run());
    const size = r.value?.meta?.size_after;
    return {
      probe: probeOf(r),
      sizeBytes:
        typeof size === "number" && Number.isFinite(size) ? size : null,
    };
  }
  const r = await timed(() => db.first("SELECT 1 AS ok"));
  return { probe: probeOf(r), sizeBytes: null };
}

/**
 * A queue's backlog through `Queue.metrics()` (April 2026). A binding whose runtime lacks the
 * method, or that refuses it, reads as `ok: false` with the reason: the fallback the S-13 [U] on
 * producer-only bindings asked for. Exported for the workerd lane.
 */
export async function queueStatus(
  queue: Queue<unknown> | undefined,
): Promise<QueueStatus> {
  const empty = {
    backlogCount: null,
    backlogBytes: null,
    oldestMessageAt: null,
  };
  if (!queue) return { ...UNBOUND, ...empty };
  if (typeof (queue as { metrics?: unknown }).metrics !== "function")
    return {
      bound: true,
      ok: false,
      latencyMs: null,
      error: "metrics() is not available on this binding",
      ...empty,
    };
  const r = await timed(() => queue.metrics());
  if (!r.value) return { ...probeOf(r), ...empty };
  const m = r.value;
  const oldest = m.oldestMessageTimestamp;
  return {
    ...probeOf(r),
    backlogCount: Number.isFinite(m.backlogCount) ? m.backlogCount : null,
    backlogBytes: Number.isFinite(m.backlogBytes) ? m.backlogBytes : null,
    oldestMessageAt:
      oldest instanceof Date && !Number.isNaN(oldest.getTime())
        ? Math.floor(oldest.getTime() / 1000)
        : typeof oldest === "number"
          ? Math.floor(oldest / 1000)
          : null,
  };
}

async function safe<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch {
    return fallback;
  }
}

interface JobRunRow {
  run_id: string;
  job: string;
  cron: string | null;
  step: string;
  started_at: number;
  duration_ms: number | null;
  outcome: string;
  items: number;
  rows_affected: number | null;
  error_summary: string | null;
}

async function jobs(db: Db) {
  const latest = async (job: string) =>
    db.first<JobRunRow>(
      `SELECT * FROM platform_job_runs WHERE job = ? AND step = ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      job,
      RUN_SUMMARY_STEP,
    );
  const [maintenance, connectorPoll, recent, failures] = await Promise.all([
    latest("maintenance"),
    latest("connectorPoll"),
    db.all<JobRunRow>(
      `SELECT * FROM platform_job_runs WHERE step = ?
        ORDER BY started_at DESC, id DESC LIMIT ?`,
      RUN_SUMMARY_STEP,
      RECENT_RUNS,
    ),
    db.all<JobRunRow>(
      `SELECT * FROM platform_job_runs WHERE outcome = 'failed' AND step <> ?
        ORDER BY started_at DESC, id DESC LIMIT ?`,
      RUN_SUMMARY_STEP,
      RECENT_FAILURES,
    ),
  ]);
  const steps = async (runId: string) =>
    (
      await db.all<JobRunRow>(
        `SELECT * FROM platform_job_runs WHERE run_id = ? AND step <> ?
          ORDER BY id`,
        runId,
        RUN_SUMMARY_STEP,
      )
    ).map((r) => ({
      step: r.step,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      outcome: r.outcome,
      items: r.items,
      rowsAffected: r.rows_affected,
      error: r.error_summary,
    }));
  const run = async (r: JobRunRow | null) =>
    r
      ? {
          runId: r.run_id,
          job: r.job,
          cron: r.cron,
          startedAt: r.started_at,
          durationMs: r.duration_ms,
          outcome: r.outcome,
          steps: await steps(r.run_id),
        }
      : null;
  return {
    latest: {
      maintenance: await run(maintenance),
      connectorPoll: await run(connectorPoll),
    },
    recent: recent.map((r) => ({
      runId: r.run_id,
      job: r.job,
      cron: r.cron,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      outcome: r.outcome,
      steps: r.items,
    })),
    failures: failures.map((r) => ({
      runId: r.run_id,
      job: r.job,
      step: r.step,
      startedAt: r.started_at,
      error: r.error_summary,
    })),
  };
}

async function heartbeats(db: Db) {
  const rows = await db.all<{
    script: string;
    at: number;
    version_tag: string | null;
    cf_version_id: string | null;
    outcome: string | null;
    backlog_count: number | null;
    backlog_bytes: number | null;
    oldest_at: number | null;
  }>("SELECT * FROM platform_heartbeats ORDER BY script");
  return rows.map((r) => ({
    script: r.script,
    at: r.at,
    versionTag: r.version_tag,
    cloudflareVersionId: r.cf_version_id,
    outcome: r.outcome,
    backlogCount: r.backlog_count,
    backlogBytes: r.backlog_bytes,
    oldestMessageAt: r.oldest_at,
  }));
}

async function blobTotals(db: Db) {
  const rows = await db.all<{
    kind: string;
    gated: number;
    bytes: number | null;
    objects: number;
  }>(
    `SELECT kind, gated, SUM(size) AS bytes, COUNT(*) AS objects
       FROM blob_objects GROUP BY kind, gated ORDER BY kind, gated`,
  );
  return {
    committedBytes: rows.reduce((n, r) => n + (r.bytes ?? 0), 0),
    objects: rows.reduce((n, r) => n + r.objects, 0),
    byKind: rows.map((r) => ({
      kind: r.kind,
      gated: r.gated === 1,
      bytes: r.bytes ?? 0,
      objects: r.objects,
    })),
  };
}

/**
 * The store connectors, aggregated across products: how many products configured each, how many
 * store objects it tracks, its last poll and last webhook, webhook deliveries that failed in the
 * last day, and the newest failed poll step from `platform_job_runs`.
 */
async function connectors(db: Db, now: number) {
  const [settings, objects, events, pollFailures] = await Promise.all([
    db.all<{ connector: string; products: number }>(
      `SELECT connector, COUNT(DISTINCT product) AS products
         FROM dist_connector_settings GROUP BY connector`,
    ),
    db.all<{
      connector: string;
      products: number;
      objects: number;
      last_polled: number | null;
    }>(
      `SELECT connector, COUNT(DISTINCT product) AS products, COUNT(*) AS objects,
              MAX(polled_at) AS last_polled
         FROM dist_connector_objects GROUP BY connector`,
    ),
    db.all<{ connector: string; last_event: number | null; failed: number }>(
      `SELECT connector, MAX(received_at) AS last_event,
              SUM(CASE WHEN outcome = 'failed' AND received_at >= ? THEN 1 ELSE 0 END) AS failed
         FROM dist_connector_events GROUP BY connector`,
      now - 86400,
    ),
    db.all<{ step: string; started_at: number; error_summary: string | null }>(
      `SELECT step, started_at, error_summary FROM platform_job_runs
        WHERE job = 'connectorPoll' AND outcome = 'failed' AND step <> ?
        ORDER BY started_at DESC, id DESC LIMIT 1`,
      RUN_SUMMARY_STEP,
    ),
  ]);
  const by = <T extends { connector: string }>(rows: T[]) =>
    new Map(rows.map((r) => [r.connector, r]));
  const s = by(settings);
  const o = by(objects);
  const e = by(events);
  const names = [
    ...new Set([
      ...CONNECTORS,
      ...settings.map((r) => r.connector),
      ...objects.map((r) => r.connector),
      ...events.map((r) => r.connector),
    ]),
  ];
  const lastFailure = pollFailures[0]
    ? {
        step: pollFailures[0].step,
        at: pollFailures[0].started_at,
        error: pollFailures[0].error_summary,
      }
    : null;
  return {
    items: names.map((connector) => ({
      connector,
      productsConfigured: Math.max(
        s.get(connector)?.products ?? 0,
        o.get(connector)?.products ?? 0,
      ),
      objectsTracked: o.get(connector)?.objects ?? 0,
      lastPolledAt: o.get(connector)?.last_polled ?? null,
      lastEventAt: e.get(connector)?.last_event ?? null,
      failedEvents24h: e.get(connector)?.failed ?? 0,
    })),
    lastPollFailure: lastFailure,
    commerce: { available: false },
  };
}

/** Lazy-delta refusals in the last 7 days, by reason (the consumer's "recent errors"). */
async function lazyDeltaRefusals(db: Db, now: number) {
  return (
    await db.all<{ reason: string | null; n: number; last: number }>(
      `SELECT reason, COUNT(*) AS n, MAX(updated_at) AS last
         FROM release_lazy_deltas WHERE state = 'refused' AND updated_at >= ?
        GROUP BY reason ORDER BY n DESC LIMIT ?`,
      now - 7 * 86400,
      RECENT_FAILURES,
    )
  ).map((r) => ({ reason: r.reason ?? "unknown", count: r.n, lastAt: r.last }));
}

export interface OperationsDeps {
  /** `missingRequiredIndexes` (from `scheduled.ts`, injected so this module stays a leaf). */
  missingIndexes(db: Db): Promise<string[]>;
}

/** Assemble the whole snapshot. Every section degrades on its own (`null` = could not read). */
export async function operationsSnapshot(
  env: Env,
  db: Db,
  now: number,
  deps: OperationsDeps,
) {
  const [d1, kv, r2, deltaQueue, deadLetter] = await Promise.all([
    probeD1(env, db),
    env.HOT
      ? timed(() => env.HOT.get(PROBE_KEY)).then(probeOf)
      : Promise.resolve(UNBOUND),
    env.BLOBS
      ? timed(() => env.BLOBS!.head(PROBE_KEY)).then(probeOf)
      : Promise.resolve(UNBOUND),
    queueStatus(env.DELTA_QUEUE),
    queueStatus(env.DELTA_DLQ),
  ]);
  const [jobRuns, beats, blobs, missing, conns, refusals] = await Promise.all([
    safe(() => jobs(db), null),
    safe(() => heartbeats(db), null),
    safe(() => blobTotals(db), null),
    safe(() => deps.missingIndexes(db), null),
    safe(() => connectors(db, now), null),
    safe(() => lazyDeltaRefusals(db, now), null),
  ]);
  return {
    generatedAt: now,
    probes: {
      d1: d1.probe,
      kv,
      r2,
      updateHealth: { bound: env.UPDATE_HEALTH != null },
      email: { bound: env.EMAIL != null },
    },
    queues: {
      deltas: deltaQueue,
      deadLetter,
      consumer: DELTA_CONSUMER_CONFIG,
    },
    heartbeats: beats,
    jobs: jobRuns,
    storage: {
      d1: { sizeBytes: d1.sizeBytes },
      // Committed objects only: `staging/` (CI uploads, expired after a day) is not in
      // `blob_objects`, so it is not counted here.
      r2: blobs,
    },
    indexes: { missing },
    connectors: conns,
    recentErrors: {
      jobFailures: jobRuns?.failures ?? null,
      lazyDeltaRefusals: refusals,
    },
  };
}
