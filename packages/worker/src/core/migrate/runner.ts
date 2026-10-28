/**
 * The data-migration runner (P0-49, CQW-17): dry run, report, apply, down, for every
 * `MigrationJob` (`./job.ts`). State lives in `data_migration_runs` and `data_migration_units`
 * (migration 0122).
 *
 *   dryRun   plans every unit, writes only the report (run mode `dry-run`, status `reported`).
 *   apply    needs the id of a dry run (the report the operator read) and applies its units one
 *            by one. A call that is killed, or that stops at its unit limit, is resumed by
 *            calling apply again with the same report: finished units are skipped, a unit that
 *            was in flight is applied again (jobs are idempotent). Applying a report whose apply
 *            finished is a no-op. A running apply holds a lease so two calls do not interleave.
 *   down     undoes the units an apply finished, against that apply's id; resumable the same way.
 *
 * Every call writes one `platform_audit` row through the one audit writer: the dry run, each
 * apply call (with units done and left) and each down call. Nothing in this module reads a job's
 * data, so nothing secret reaches the report; a job's `detail` is its own to keep clean.
 *
 * Nothing schedules a run. The only caller is the admin route (`console/handlers/migrations.ts`),
 * and `test/surfaces/console/migrationRunner.test.ts` greps `src/` to keep it that way.
 */

import type { Db, DbStatement } from "../../db/types.js";
import { randomId } from "../../platform/crypto.js";
import { parseJsonColumn } from "../../platform/json.js";
import {
  actorColumns,
  platformAuditStatement,
  type AuditActor,
} from "../audit.js";
import type { MigrationContext, MigrationJob } from "./job.js";

/** How long one apply or down call holds a run (seconds). A killed call is resumable after it. */
export const MIGRATION_LEASE_SECONDS = 120;

/** An apply of a new report older than this is refused: dry-run again. */
export const MIGRATION_REPORT_MAX_AGE_SECONDS = 24 * 3600;

export type RunMode = "dry-run" | "apply" | "down";
export type RunStatus =
  | "reported"
  | "running"
  | "failed"
  | "applied"
  | "reverted";
export type UnitStatus = "pending" | "done" | "failed";

export interface UnitView {
  unit: string;
  status: UnitStatus;
  /** Rows the dry run said the apply would change. */
  planned: number;
  /** Rows an apply or down changed. */
  changes: number;
  detail: unknown;
  error: string | null;
}

export interface RunView {
  id: string;
  job: string;
  mode: RunMode;
  status: RunStatus;
  sourceId: string | null;
  requestedBy: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** A dry run: the diffs (zero = already migrated). An apply or down: rows changed so far. */
  changes: number;
  units: UnitView[];
  /** Units not yet done. */
  remaining: number;
}

export type RunRefusal =
  | "unknown_report" // no dry run with that id for the job
  | "report_incomplete" // the dry run had a unit it could not plan
  | "unknown_apply" // no apply with that id for the job
  | "nothing_applied" // down of an apply with no finished unit
  | "reverted" // the apply was undone: dry-run again for a fresh report
  | "busy" // another call holds the run
  | "lease_lost" // this call's lease lapsed and another call took the run over
  | "reverting" // a down exists for this apply: apply and down exclude each other
  | "report_stale" // the dry run is older than MIGRATION_REPORT_MAX_AGE_SECONDS
  | "delegated"; // the job has its own flow (`MigrationJob.delegatedTo`): the runner only reports

export type RunResult =
  | { ok: true; run: RunView; noop: boolean }
  | { ok: false; reason: RunRefusal };

interface RunRow {
  id: string;
  job: string;
  mode: RunMode;
  status: RunStatus;
  source_id: string | null;
  requested_by: string | null;
  started_at: number;
  finished_at: number | null;
  lease_until: number | null;
  lease_token: string | null;
  changes: number;
}

interface UnitRow {
  run_id: string;
  unit: string;
  status: UnitStatus;
  planned: number;
  changes: number;
  detail_json: string | null;
  error: string | null;
}

function viewOf(run: RunRow, units: UnitRow[]): RunView {
  return {
    id: run.id,
    job: run.job,
    mode: run.mode,
    status: run.status,
    sourceId: run.source_id,
    requestedBy: run.requested_by,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    changes: run.changes,
    units: units.map((u) => ({
      unit: u.unit,
      status: u.status,
      planned: u.planned,
      changes: u.changes,
      detail: parseJsonColumn(u.detail_json),
      error: u.error,
    })),
    remaining: units.filter((u) => u.status !== "done").length,
  };
}

async function runRow(db: Db, id: string): Promise<RunRow | null> {
  return db.first<RunRow>("SELECT * FROM data_migration_runs WHERE id = ?", id);
}

async function unitRows(db: Db, runId: string): Promise<UnitRow[]> {
  return db.all<UnitRow>(
    "SELECT * FROM data_migration_units WHERE run_id = ? ORDER BY unit",
    runId,
  );
}

/** One run with its units, or `null`. */
export async function getRun(db: Db, id: string): Promise<RunView | null> {
  const run = await runRow(db, id);
  return run ? viewOf(run, await unitRows(db, id)) : null;
}

/** A job's runs, newest first, without their units. */
export async function listRuns(
  db: Db,
  job: string,
  limit = 20,
): Promise<RunView[]> {
  const rows = await db.all<RunRow>(
    "SELECT * FROM data_migration_runs WHERE job = ? ORDER BY started_at DESC, id DESC LIMIT ?",
    job,
    limit,
  );
  return rows.map((r) => viewOf(r, []));
}

function auditStmt(
  actor: AuditActor,
  now: number,
  action: string,
  job: string,
  summary: string,
  after: unknown,
  tail?: { sql: string; params: string[] },
): DbStatement {
  return platformAuditStatement(
    {
      at: now,
      ...actorColumns(actor),
      action,
      target_kind: "migration",
      target_id: job,
      summary,
      before_json: null,
      after_json: JSON.stringify(after),
    },
    tail,
  );
}

function insertUnit(
  runId: string,
  unit: string,
  status: UnitStatus,
  planned: number,
  detail: unknown,
  error: string | null,
  now: number,
): DbStatement {
  return {
    sql: `INSERT INTO data_migration_units (run_id, unit, status, planned, changes, detail_json, error, at)
          VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    params: [
      runId,
      unit,
      status,
      planned,
      detail === undefined ? null : JSON.stringify(detail),
      error,
      now,
    ],
  };
}

/** The dry run: plan every unit, store the report, change nothing else. */
export async function dryRun(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
): Promise<RunView> {
  const id = randomId("mig");
  const stmts: DbStatement[] = [];
  let diffs = 0;
  let failed = 0;
  const units = await job.units(ctx);
  for (const unit of units) {
    try {
      const plan = await job.plan(ctx, unit);
      diffs += plan.changes;
      stmts.push(
        insertUnit(
          id,
          unit,
          "pending",
          plan.changes,
          plan.detail,
          null,
          ctx.now,
        ),
      );
    } catch (e) {
      failed += 1;
      stmts.push(
        insertUnit(
          id,
          unit,
          "failed",
          0,
          undefined,
          e instanceof Error ? e.name : "error",
          ctx.now,
        ),
      );
    }
  }
  const report = { units: units.length, diffs, failed };
  await ctx.db.batch([
    {
      sql: `INSERT INTO data_migration_runs
              (id, job, mode, status, requested_by, started_at, finished_at, changes, report_json)
            VALUES (?, ?, 'dry-run', 'reported', ?, ?, ?, ?, ?)`,
      params: [
        id,
        job.id,
        actor.sub,
        ctx.now,
        ctx.now,
        diffs,
        JSON.stringify(report),
      ],
    },
    ...stmts,
    auditStmt(
      actor,
      ctx.now,
      "migration.dry-run",
      job.id,
      `Dry run of ${job.id}: ${diffs} change(s) in ${units.length} unit(s)`,
      { run: id, ...report },
    ),
  ]);
  return (await getRun(ctx.db, id)) as RunView;
}

export interface StepOptions {
  /** Units to process in this call; the rest wait for the next call. Default all. */
  limit?: number;
}

type Step = "apply" | "down";

/** True while the run's row still carries this call's token (a guard for a batch's statements). */
function held(runId: string, token: string): { sql: string; params: string[] } {
  return {
    sql: "EXISTS (SELECT 1 FROM data_migration_runs WHERE id = ? AND lease_token = ?)",
    params: [runId, token],
  };
}

/** Claim a run for this call: true when the lease was free or had lapsed. */
async function claim(
  db: Db,
  id: string,
  token: string,
  now: number,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `UPDATE data_migration_runs SET status = 'running', lease_until = ?, lease_token = ?
        WHERE id = ? AND status IN ('running', 'failed') AND (lease_until IS NULL OR lease_until <= ?)`,
      now + MIGRATION_LEASE_SECONDS,
      token,
      id,
      now,
    )) > 0
  );
}

/** Hold an apply run's lease without touching its status (the down's guard against a live apply). */
async function claimSource(
  db: Db,
  id: string,
  token: string,
  now: number,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `UPDATE data_migration_runs SET lease_until = ?, lease_token = ?
        WHERE id = ? AND mode = 'apply' AND (lease_until IS NULL OR lease_until <= ?)`,
      now + MIGRATION_LEASE_SECONDS,
      token,
      id,
      now,
    )) > 0
  );
}

async function release(db: Db, id: string, token: string): Promise<void> {
  await db.run(
    "UPDATE data_migration_runs SET lease_until = NULL, lease_token = NULL WHERE id = ? AND lease_token = ?",
    id,
    token,
  );
}

type Acquired =
  | { ok: true; runId: string; token: string }
  | { ok: false; reason: "busy" };

/**
 * The run for (`sourceId`, `mode`), leased to this call. The first call creates it; the unique
 * index on (source_id, mode) makes a racing first call fail its insert, and it then goes through
 * `claim` like any resume, so two parallel first calls make one run and one of them is `busy`.
 */
async function acquire(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  mode: "apply" | "down",
  sourceId: string,
  units: Array<{ unit: string; planned: number }>,
): Promise<Acquired> {
  const token = randomId("lease");
  const find = () =>
    ctx.db.first<RunRow>(
      "SELECT * FROM data_migration_runs WHERE source_id = ? AND mode = ?",
      sourceId,
      mode,
    );
  const existing = await find();
  if (!existing) {
    const runId = randomId("mig");
    try {
      await ctx.db.batch([
        {
          sql: `INSERT INTO data_migration_runs
                  (id, job, mode, status, source_id, requested_by, started_at, lease_until, lease_token, changes)
                VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, 0)`,
          params: [
            runId,
            job.id,
            mode,
            sourceId,
            actor.sub,
            ctx.now,
            ctx.now + MIGRATION_LEASE_SECONDS,
            token,
          ],
        },
        ...units.map((u) =>
          insertUnit(runId, u.unit, "pending", u.planned, null, null, ctx.now),
        ),
      ]);
      return { ok: true, runId, token };
    } catch (e) {
      if (!(await find())) throw e; // not the race: a real failure
    }
  }
  const run = (await find()) as RunRow;
  return (await claim(ctx.db, run.id, token, ctx.now))
    ? { ok: true, runId: run.id, token }
    : { ok: false, reason: "busy" };
}

/**
 * Run the pending units of a leased run through the job's `apply` or `down`; settle the run.
 * Every write to the run is conditional on the call's token and the lease is renewed before each
 * unit, so a call whose lease lapsed and was taken over stops writing (`null`).
 */
async function drive(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  runId: string,
  token: string,
  step: Step,
  opts: StepOptions,
): Promise<RunView | null> {
  const started = Date.now();
  const clock = () => ctx.now + Math.floor((Date.now() - started) / 1000);
  const guard = held(runId, token);
  const pending = (await unitRows(ctx.db, runId)).filter(
    (u) => u.status !== "done",
  );
  // The unit detail of the run this one reads: the report an apply was pinned to, or the apply
  // a down undoes.
  const sourceId = ((await runRow(ctx.db, runId))?.source_id ?? null) as
    | string
    | null;
  const budget = opts.limit ?? pending.length;
  let done = 0;
  let changed = 0;
  let failed = false;
  for (const u of pending.slice(0, Math.max(0, budget))) {
    const renewed = await ctx.db.runChanges(
      "UPDATE data_migration_runs SET lease_until = ? WHERE id = ? AND lease_token = ?",
      clock() + MIGRATION_LEASE_SECONDS,
      runId,
      token,
    );
    if (renewed === 0) return null;
    let n: number;
    let detail: unknown;
    try {
      const source = sourceId
        ? await ctx.db.first<{ detail_json: string | null }>(
            "SELECT detail_json FROM data_migration_units WHERE run_id = ? AND unit = ?",
            sourceId,
            u.unit,
          )
        : null;
      const carried = parseJsonColumn(source?.detail_json ?? null);
      // Each unit sees the time it starts, not the time the call started: a job that stamps
      // `now` (F-34.4's cache-window ledger) must not stamp a moment its write precedes.
      const unitCtx = { ...ctx, now: clock() };
      const outcome = await (step === "apply"
        ? job.apply(unitCtx, u.unit, carried)
        : job.down(unitCtx, u.unit, carried));
      n = typeof outcome === "number" ? outcome : outcome.changes;
      detail = typeof outcome === "number" ? undefined : outcome.detail;
    } catch (e) {
      const marked = await ctx.db.runChanges(
        `UPDATE data_migration_units SET status = 'failed', error = ?, at = ?
          WHERE run_id = ? AND unit = ? AND ${guard.sql}`,
        e instanceof Error ? e.name : "error",
        ctx.now,
        runId,
        u.unit,
        ...guard.params,
      );
      if (marked === 0) return null;
      failed = true;
      break; // later units wait: a failure may be shared
    }
    const stmts: DbStatement[] = [
      {
        sql: `UPDATE data_migration_units SET status = 'done', changes = ?, error = NULL, at = ?,
                     detail_json = ?
               WHERE run_id = ? AND unit = ? AND ${guard.sql}`,
        params: [
          n,
          ctx.now,
          detail === undefined ? null : JSON.stringify(detail),
          runId,
          u.unit,
          ...guard.params,
        ],
      },
      {
        sql: `UPDATE data_migration_runs SET changes = changes + ? WHERE id = ? AND lease_token = ?`,
        params: [n, runId, token],
      },
    ];
    if (ctx.db.batchChanges) {
      const r = await ctx.db.batchChanges(stmts);
      if ((r[0] ?? 0) === 0) return null;
    } else {
      await ctx.db.batch(stmts);
    }
    done += 1;
    changed += n;
  }
  const remaining = pending.length - done;
  const finalStatus: RunStatus =
    remaining === 0 ? (step === "apply" ? "applied" : "reverted") : "running";
  const status: RunStatus = failed ? "failed" : finalStatus;
  const run = await runRow(ctx.db, runId);
  const settle: DbStatement[] = [
    auditStmt(
      actor,
      ctx.now,
      `migration.${step}`,
      job.id,
      `${step === "apply" ? "Applied" : "Reverted"} ${done} unit(s) of ${job.id}, ${remaining} left`,
      { run: runId, done, changes: changed, remaining, status },
      { sql: `WHERE ${guard.sql}`, params: guard.params },
    ),
  ];
  if (step === "down" && status === "reverted" && run?.source_id)
    settle.push({
      sql: `UPDATE data_migration_runs SET status = 'reverted' WHERE id = ? AND ${guard.sql}`,
      params: [run.source_id, ...guard.params],
    });
  settle.push({
    sql: `UPDATE data_migration_runs SET status = ?, lease_until = NULL, lease_token = NULL, finished_at = ?
           WHERE id = ? AND lease_token = ?`,
    params: [status, remaining === 0 && !failed ? ctx.now : null, runId, token],
  });
  await ctx.db.batch(settle);
  const after = await runRow(ctx.db, runId);
  if (after?.lease_token === token) return null; // the settle did not land
  return (await getRun(ctx.db, runId)) as RunView;
}

/**
 * Apply a job against a dry run's report. Creates the apply run on the first call and resumes
 * it on later ones; a finished apply answers `noop`.
 */
export async function apply(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  reportId: string,
  opts: StepOptions = {},
): Promise<RunResult> {
  if (job.delegatedTo) return { ok: false, reason: "delegated" };
  const report = await runRow(ctx.db, reportId);
  if (!report || report.job !== job.id || report.mode !== "dry-run")
    return { ok: false, reason: "unknown_report" };
  const reportUnits = await unitRows(ctx.db, reportId);
  if (reportUnits.some((u) => u.status === "failed"))
    return { ok: false, reason: "report_incomplete" };

  const existing = await ctx.db.first<RunRow>(
    "SELECT * FROM data_migration_runs WHERE source_id = ? AND mode = 'apply'",
    reportId,
  );
  if (existing?.status === "applied")
    return {
      ok: true,
      noop: true,
      run: viewOf(existing, await unitRows(ctx.db, existing.id)),
    };
  if (existing?.status === "reverted") return { ok: false, reason: "reverted" };
  if (
    !existing &&
    ctx.now - report.started_at > MIGRATION_REPORT_MAX_AGE_SECONDS
  )
    return { ok: false, reason: "report_stale" };

  const got = await acquire(
    ctx,
    job,
    actor,
    "apply",
    reportId,
    reportUnits.map((u) => ({ unit: u.unit, planned: u.planned })),
  );
  if (!got.ok) return got;
  // A down for this apply excludes it. Checked after the lease: a down holds the apply's lease
  // while it creates its run, so either that run is visible here or the down was refused busy.
  const undoing = await ctx.db.first(
    "SELECT id FROM data_migration_runs WHERE source_id = ? AND mode = 'down'",
    got.runId,
  );
  if (undoing) {
    await release(ctx.db, got.runId, got.token);
    return { ok: false, reason: "reverting" };
  }
  const run = await drive(ctx, job, actor, got.runId, got.token, "apply", opts);
  return run
    ? { ok: true, noop: false, run }
    : { ok: false, reason: "lease_lost" };
}

/**
 * Undo an apply: the job's `down` over the units that apply changed. Resumes a partial down;
 * a finished one answers `noop`. It takes the apply's lease first, so it never runs beside a
 * live apply, and once its run exists an apply of the same report is refused.
 */
export async function down(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  applyId: string,
  opts: StepOptions = {},
): Promise<RunResult> {
  if (job.delegatedTo) return { ok: false, reason: "delegated" };
  const source = await runRow(ctx.db, applyId);
  if (!source || source.job !== job.id || source.mode !== "apply")
    return { ok: false, reason: "unknown_apply" };
  const finished = await ctx.db.first<RunRow>(
    "SELECT * FROM data_migration_runs WHERE source_id = ? AND mode = 'down' AND status = 'reverted'",
    applyId,
  );
  if (finished)
    return {
      ok: true,
      noop: true,
      run: viewOf(finished, await unitRows(ctx.db, finished.id)),
    };
  const sourceToken = randomId("lease");
  if (!(await claimSource(ctx.db, applyId, sourceToken, ctx.now)))
    return { ok: false, reason: "busy" };
  try {
    // Only units the apply changed: a no-op unit's data was there before the apply.
    const changedUnits = (await unitRows(ctx.db, applyId)).filter(
      (u) => u.status === "done" && u.changes > 0,
    );
    const hasRun = await ctx.db.first(
      "SELECT id FROM data_migration_runs WHERE source_id = ? AND mode = 'down'",
      applyId,
    );
    if (!hasRun && changedUnits.length === 0)
      return { ok: false, reason: "nothing_applied" };
    const got = await acquire(
      ctx,
      job,
      actor,
      "down",
      applyId,
      changedUnits.map((u) => ({ unit: u.unit, planned: u.changes })),
    );
    if (!got.ok) return got;
    await release(ctx.db, applyId, sourceToken);
    const run = await drive(
      ctx,
      job,
      actor,
      got.runId,
      got.token,
      "down",
      opts,
    );
    return run
      ? { ok: true, noop: false, run }
      : { ok: false, reason: "lease_lost" };
  } finally {
    await release(ctx.db, applyId, sourceToken);
  }
}
