/**
 * The data-migration runner on the console (P0-49), platform scope, platform admins only
 * (`handlePlatform`'s gate). No page: the operator or the lead calls it. Every call is audited.
 *
 *   GET  /api/platform/migrations                jobs, each with its latest runs
 *   GET  /api/platform/migrations/runs/<id>      one run with its units (the report)
 *   POST /api/platform/migrations/dry-run        { job }                  the report; writes nothing else
 *   POST /api/platform/migrations/apply          { job, report, limit? }  against a report (step-up)
 *   POST /api/platform/migrations/down           { job, run, limit? }     undo an apply (step-up)
 *
 * Apply and down resume: call again with the same ids until `remaining` is 0. Nothing here runs
 * on deploy or on a schedule.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { AdminSession } from "../../core/console/session.js";
import { actorOf } from "../../core/audit.js";
import { ErrorCode } from "../../core/errors.js";
import { migrationJobs } from "../../core/contributions.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import {
  apply,
  down,
  dryRun,
  getRun,
  listRuns,
  type RunRefusal,
  type RunResult,
} from "../../core/migrate/runner.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";

/** The admin API's limiter shard (`../api.ts`). */
const ADMIN_RL_SHARD = "_admin";

const STATUS: Record<RunRefusal, number> = {
  unknown_report: 404,
  unknown_apply: 404,
  report_incomplete: 409,
  nothing_applied: 409,
  reverted: 409,
  busy: 409,
  lease_lost: 409,
  reverting: 409,
  report_stale: 409,
  delegated: 409,
};

function answer(r: RunResult): Response {
  if (!r.ok)
    return err(STATUS[r.reason], r.reason, r.reason.replace(/_/g, " "));
  return adminJson({ run: r.run, noop: r.noop });
}

export async function handleMigrations(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  const jobs = migrationJobs();
  const ctx = { env, db, now };
  const actor = actorOf(session);

  if (rest.length === 0) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson({
      jobs: await Promise.all(
        jobs.map(async (j) => ({
          id: j.id,
          summary: j.summary,
          runs: await listRuns(db, j.id, 5),
        })),
      ),
    });
  }
  if (rest.length === 2 && rest[0] === "runs") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const run = await getRun(db, rest[1] ?? "");
    return run ? adminJson({ run }) : notFound();
  }
  const verb = rest[0];
  if (rest.length !== 1 || !["dry-run", "apply", "down"].includes(verb ?? ""))
    return notFound();
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");

  const body = await readBody(req);
  const job = jobs.find((j) => j.id === body.job);
  if (!job) return notFound();
  if (verb === "dry-run") {
    // A dry run plans every product and writes run, unit and audit rows: a tight budget per
    // caller (a `pkeya_` token's sub is `token:<id>`, so it has its own; a `pkeyp_` token acts as its holder, so it shares the person's `mbr_` budget).
    if (
      !(await rateLimitOk(
        env,
        ADMIN_RL_SHARD,
        {
          bucket: "migrationDryRun",
          id: actor.sub ?? "",
          limit: 6,
          windowSec: 60,
        },
        now,
      ))
    )
      return err(429, "rate_limited", "too many dry runs");
    return adminJson({ run: await dryRun(ctx, job, actor) });
  }

  const key = verb === "apply" ? body.report : body.run;
  if (typeof key !== "string" || key === "")
    return err(
      400,
      ErrorCode.BadRequest,
      `${verb === "apply" ? "report" : "run"} is required`,
    );
  const limit = body.limit;
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
  )
    return err(400, ErrorCode.BadRequest, "limit must be a positive integer");
  const opts = { limit };
  return answer(
    verb === "apply"
      ? await apply(ctx, job, actor, key, opts)
      : await down(ctx, job, actor, key, opts),
  );
}
