/**
 * The data-migration runner (P0-49, CQW-17): dry run, report, apply, down, for every
 * `MigrationJob` (`./job.ts`). State lives in `data_migration_runs` and `data_migration_units`
 * (migration 0121).
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
 * and `test/migrationRunner.test.ts` greps `src/` to keep it that way.
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
  | "busy"; // another call holds the run

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
): DbStatement {
  return platformAuditStatement({
    at: now,
    ...actorColumns(actor),
    action,
    target_kind: "migration",
    target_id: job,
    summary,
    before_json: null,
    after_json: JSON.stringify(after),
  });
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

/** Claim a run for this call: true when the lease was free or had lapsed. */
async function claim(db: Db, id: string, now: number): Promise<boolean> {
  const changed = await db.runChanges(
    `UPDATE data_migration_runs SET status = 'running', lease_until = ?
      WHERE id = ? AND status IN ('running', 'failed') AND (lease_until IS NULL OR lease_until <= ?)`,
    now + MIGRATION_LEASE_SECONDS,
    id,
    now,
  );
  return changed > 0;
}

/** Run the pending units of `run` through the job's `apply` or `down`; settle the run. */
async function drive(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  runId: string,
  step: Step,
  opts: StepOptions,
): Promise<RunView> {
  const pending = (await unitRows(ctx.db, runId)).filter(
    (u) => u.status !== "done",
  );
  const budget = opts.limit ?? pending.length;
  let done = 0;
  let changed = 0;
  let failed = false;
  for (const u of pending.slice(0, Math.max(0, budget))) {
    try {
      const n = await (step === "apply"
        ? job.apply(ctx, u.unit)
        : job.down(ctx, u.unit));
      await ctx.db.batch([
        {
          sql: `UPDATE data_migration_units SET status = 'done', changes = ?, error = NULL, at = ?
                 WHERE run_id = ? AND unit = ?`,
          params: [n, ctx.now, runId, u.unit],
        },
        {
          sql: "UPDATE data_migration_runs SET changes = changes + ? WHERE id = ?",
          params: [n, runId],
        },
      ]);
      done += 1;
      changed += n;
    } catch (e) {
      failed = true;
      await ctx.db.run(
        `UPDATE data_migration_units SET status = 'failed', error = ?, at = ?
          WHERE run_id = ? AND unit = ?`,
        e instanceof Error ? e.name : "error",
        ctx.now,
        runId,
        u.unit,
      );
      break; // later units wait: a failure may be shared
    }
  }
  const remaining = pending.length - done;
  const finalStatus: RunStatus =
    remaining === 0 ? (step === "apply" ? "applied" : "reverted") : "running";
  const status: RunStatus = failed ? "failed" : finalStatus;
  const settle: DbStatement[] = [
    {
      sql: `UPDATE data_migration_runs SET status = ?, lease_until = NULL, finished_at = ? WHERE id = ?`,
      params: [status, remaining === 0 && !failed ? ctx.now : null, runId],
    },
    auditStmt(
      actor,
      ctx.now,
      `migration.${step}`,
      job.id,
      `${step === "apply" ? "Applied" : "Reverted"} ${done} unit(s) of ${job.id}, ${remaining} left`,
      { run: runId, done, changes: changed, remaining, status },
    ),
  ];
  const run = await runRow(ctx.db, runId);
  if (step === "down" && status === "reverted" && run?.source_id)
    settle.push({
      sql: "UPDATE data_migration_runs SET status = 'reverted' WHERE id = ?",
      params: [run.source_id],
    });
  await ctx.db.batch(settle);
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

  let runId = existing?.id;
  if (!runId) {
    runId = randomId("mig");
    await ctx.db.batch([
      {
        sql: `INSERT INTO data_migration_runs
                (id, job, mode, status, source_id, requested_by, started_at, lease_until, changes)
              VALUES (?, ?, 'apply', 'running', ?, ?, ?, ?, 0)`,
        params: [
          runId,
          job.id,
          reportId,
          actor.sub,
          ctx.now,
          ctx.now + MIGRATION_LEASE_SECONDS,
        ],
      },
      ...reportUnits.map((u) =>
        insertUnit(
          runId as string,
          u.unit,
          "pending",
          u.planned,
          null,
          null,
          ctx.now,
        ),
      ),
    ]);
  } else if (!(await claim(ctx.db, runId, ctx.now)))
    return { ok: false, reason: "busy" };
  return {
    ok: true,
    noop: false,
    run: await drive(ctx, job, actor, runId, "apply", opts),
  };
}

/**
 * Undo an apply: the job's `down` over the units that apply finished. Resumes a partial down;
 * a finished one answers `noop`.
 */
export async function down(
  ctx: MigrationContext,
  job: MigrationJob,
  actor: AuditActor,
  applyId: string,
  opts: StepOptions = {},
): Promise<RunResult> {
  const source = await runRow(ctx.db, applyId);
  if (!source || source.job !== job.id || source.mode !== "apply")
    return { ok: false, reason: "unknown_apply" };
  if (source.status === "running" && (source.lease_until ?? 0) > ctx.now)
    return { ok: false, reason: "busy" };
  const existing = await ctx.db.first<RunRow>(
    "SELECT * FROM data_migration_runs WHERE source_id = ? AND mode = 'down'",
    applyId,
  );
  if (existing?.status === "reverted")
    return {
      ok: true,
      noop: true,
      run: viewOf(existing, await unitRows(ctx.db, existing.id)),
    };
  let runId = existing?.id;
  if (!runId) {
    const finished = (await unitRows(ctx.db, applyId)).filter(
      (u) => u.status === "done",
    );
    if (finished.length === 0) return { ok: false, reason: "nothing_applied" };
    runId = randomId("mig");
    await ctx.db.batch([
      {
        sql: `INSERT INTO data_migration_runs
                (id, job, mode, status, source_id, requested_by, started_at, lease_until, changes)
              VALUES (?, ?, 'down', 'running', ?, ?, ?, ?, 0)`,
        params: [
          runId,
          job.id,
          applyId,
          actor.sub,
          ctx.now,
          ctx.now + MIGRATION_LEASE_SECONDS,
        ],
      },
      ...finished.map((u) =>
        insertUnit(
          runId as string,
          u.unit,
          "pending",
          u.changes,
          null,
          null,
          ctx.now,
        ),
      ),
    ]);
  } else if (!(await claim(ctx.db, runId, ctx.now)))
    return { ok: false, reason: "busy" };
  return {
    ok: true,
    noop: false,
    run: await drive(ctx, job, actor, runId, "down", opts),
  };
}
