/**
 * The settings backfill's admin routes (ST-01c; notes/S-18 §4.14, owner decision D19). Behind the
 * dispatcher's platform-admin session, limiter and CSRF check, like every admin route:
 *
 *   POST /api/products/<slug>/settings/backfill?dryRun=1|0[&expectCommit=<sha>]
 *        — classify the product against its manifest and store the report (`dryRun=1`), or apply
 *          it: every declared field and row takes its manifest value, undeclared console rows
 *          stay as `console`, one `setting.backfill` audit row (`dryRun=0`). `dryRun` is
 *          REQUIRED, so a bare POST never applies. `expectCommit` (the dry run's `commit`) makes
 *          the apply refuse with 409 `commit_moved` when the manifest moved since;
 *   GET  /api/products/<slug>/settings/backfill        — the product's reports, newest first;
 *   GET  /api/products/<slug>/settings/backfill/<id>   — one report;
 *   POST /api/platform/settings/backfill?dryRun=1|0[&after=<slug>]
 *        — the platform batch over every product (at most `BATCH_LIMIT` per call; `next`
 *          continues), audited once in `platform_audit` as `settings.backfill.batch`;
 *   GET  /api/platform/settings/backfill               — every product's newest report (no body).
 *
 * Admin routes are narrative-only under AGENTS.md rule 10 (`adminApi` and `products` in
 * routeCoverage's NARRATIVE_ONLY); the operator procedure is docs/RUNBOOK.md "Settings backfill".
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import { gitShaOrNull } from "../../core/manifestSnapshot.js";
import {
  getReport,
  latestReportPerProduct,
  listReports,
  reportOf,
  type BackfillReportRow,
} from "../../core/settingsBackfill.js";
import type { AuditActor } from "../../core/settingsClaims.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound } from "../lib/respond.js";
import { platformAudit } from "../audit.js";
import {
  runPlatformBackfill,
  runSettingsBackfill,
} from "../settingsBackfill.js";

function actorOf(session: AdminSession): AuditActor {
  return { sub: session.sub, name: session.name, email: session.email };
}

/** `dryRun` as the routes require it: exactly `1` or `0`, or `null` (refused with 400). */
function dryRunOf(url: URL): boolean | null {
  const v = url.searchParams.get("dryRun");
  return v === "1" ? true : v === "0" ? false : null;
}

const DRY_RUN_REQUIRED = () =>
  err(
    400,
    ErrorCode.BadRequest,
    "dryRun is required: 1 to classify and store the report, 0 to apply",
    { fields: ["dryRun"] },
  );

function rowView(row: BackfillReportRow) {
  return {
    id: row.id,
    at: row.at,
    mode: row.mode,
    outcome: row.outcome,
    batchId: row.batch_id,
    commit: row.commit_sha,
    changes: row.changes,
    actor: { sub: row.actor_sub, name: row.actor_name },
  };
}

/** `…/products/<slug>/settings/backfill[/<id>]`; `rest` is what follows `backfill`. */
export async function handleProductSettingsBackfill(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length > 1) return notFound();
  if (rest.length === 1) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const row = await getReport(db, slug, rest[0]!);
    if (!row) return notFound();
    return adminJson({ ...rowView(row), report: reportOf(row) });
  }
  if (req.method === "GET") {
    const rows = await listReports(db, slug);
    return adminJson({
      reports: rows.map((r) => ({ ...rowView(r), report: reportOf(r) })),
    });
  }
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const url = new URL(req.url);
  const dryRun = dryRunOf(url);
  if (dryRun === null) return DRY_RUN_REQUIRED();
  const rawExpect = url.searchParams.get("expectCommit");
  const expectCommit = rawExpect === null ? null : gitShaOrNull(rawExpect);
  if (rawExpect !== null && expectCommit === null)
    return err(
      400,
      ErrorCode.BadRequest,
      "expectCommit must be a lowercase git commit id",
      { fields: ["expectCommit"] },
    );
  const run = await runSettingsBackfill(env, db, slug, {
    dryRun,
    actor: actorOf(session),
    now,
    fetchImpl: fetch,
    expectCommit,
  });
  if (!run.ok)
    return run.status === 404
      ? notFound()
      : err(run.status, ErrorCode.BadRequest, run.message, {
          reason: run.reason,
        });
  return adminJson({
    ok: true,
    dryRun,
    reportId: run.report.id,
    outcome: run.report.outcome,
    changes: run.report.changes,
    commit: run.report.source?.commit ?? null,
    report: run.report,
  });
}

/** `…/platform/settings/backfill`; the caller has checked the platform-admin gate. */
export async function handlePlatformSettingsBackfill(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  now: number,
): Promise<Response> {
  if (req.method === "GET") {
    const rows = await latestReportPerProduct(db);
    return adminJson({
      products: rows.map((r) => ({
        product: r.product,
        ...rowView({ ...r, report_json: "" }),
      })),
    });
  }
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const url = new URL(req.url);
  const dryRun = dryRunOf(url);
  if (dryRun === null) return DRY_RUN_REQUIRED();
  const result = await runPlatformBackfill(env, db, {
    dryRun,
    actor: actorOf(session),
    now,
    fetchImpl: fetch,
    after: url.searchParams.get("after"),
  });
  const count = (o: string) =>
    result.products.filter((p) => p.outcome === o).length;
  const outcomes = [
    "planned",
    "applied",
    "unchanged",
    "unlinked",
    "unreadable",
    "refused",
    "conflict",
    "commit_moved",
    "error",
  ]
    .map((o) => [o, count(o)] as const)
    .filter(([, n]) => n > 0);
  await platformAudit(
    db,
    session,
    now,
    "settings.backfill.batch",
    null,
    `Settings backfill ${dryRun ? "dry run" : "apply"} over ${result.products.length} product${result.products.length === 1 ? "" : "s"}: ${outcomes.map(([o, n]) => `${n} ${o}`).join(", ") || "none"} (batch ${result.batchId})`,
    {
      after: {
        batchId: result.batchId,
        dryRun,
        products: result.products.map((p) => ({
          product: p.product,
          outcome: p.outcome,
          reportId: p.reportId,
          changes: p.changes,
        })),
        next: result.next,
      },
    },
  );
  return adminJson({ ok: true, ...result });
}
