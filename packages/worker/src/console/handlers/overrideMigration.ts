/**
 * The licence-override migration on the console (U-03; notes/S-17 §5.12, decision 21), platform
 * scope. Platform admins only (`handlePlatform`'s gate); every write is in the platform audit log.
 *
 *   GET    /api/platform/override-migration[?product=<slug>]
 *            the state (prerequisites, notice, run), the daily inventory, and with `product` that
 *            product's licence list (key names only) and its live report row count
 *   PUT    /api/platform/override-migration/prerequisites   { loginCard?: bool, library?: bool }
 *            flag I-07 and I-11 live in production (or unflag, before the notice)
 *   POST   /api/platform/override-migration/notice          start the 30-day notice
 *   DELETE /api/platform/override-migration/notice          withdraw it (before the run)
 *   POST   /api/platform/override-migration/dry-run         { product? } the inventory and the
 *            report the run would write; writes nothing, reads no secret
 *   POST   /api/platform/override-migration/run             start or continue the run (step-up)
 *   GET    /api/platform/override-migration/report[?product=&format=csv]
 *            the report, 90 days; secret values are never in it
 *
 * The production run is the owner's to schedule (docs/RUNBOOK.md, "Licence override migration").
 * Nothing here runs it by itself: the run needs the notice, the notice needs both prerequisites,
 * and the run route needs a fresh sign-in.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../core/errors.js";
import {
  OVERRIDE_MIGRATION_NOTICE_DAYS,
  OVERRIDE_MIGRATION_REPORT_DAYS,
  dryRunOverrideMigration,
  licenseConfigFrozen,
  licenseConfigRetired,
  listOverrideMigrationReport,
  overrideMigrationReportCsv,
  productOverrideInventory,
  readOverrideMigrationState,
  runOverrideMigration,
  setOverrideMigrationPrerequisite,
  startOverrideMigrationNotice,
  withdrawOverrideMigrationNotice,
  type MigrationActor,
  type OverrideMigrationPrerequisite,
  type OverrideMigrationState,
} from "../../core/ops/overrideMigration.js";
import { getProduct } from "../../core/repo.js";
import { appSecurityHeaders } from "../../platform/securityHeaders.js";
import { platformAudit } from "../../core/console/audit.js";
import {
  adminJson,
  err,
  notFound,
  readBody,
} from "../../core/console/respond.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  isSteppedUp,
  type AdminSession,
} from "../../core/console/session.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

function actorOf(session: AdminSession): MigrationActor {
  return {
    sub: session.sub,
    name: session.name || null,
    email: session.email || null,
  };
}

/** The state as the console reads it (who flagged what is a subject, never an email). */
function stateView(s: OverrideMigrationState, now: number) {
  const phase = licenseConfigRetired(s)
    ? "completed"
    : licenseConfigFrozen(s)
      ? "running"
      : s.noticeStartedAt !== null
        ? "notice"
        : "idle";
  return {
    phase,
    noticeDays: OVERRIDE_MIGRATION_NOTICE_DAYS,
    reportDays: OVERRIDE_MIGRATION_REPORT_DAYS,
    prerequisites: {
      loginCard: { liveAt: s.loginCardLiveAt, by: s.loginCardLiveBy },
      library: { liveAt: s.libraryLiveAt, by: s.libraryLiveBy },
    },
    notice: {
      startedAt: s.noticeStartedAt,
      by: s.noticeStartedBy,
      runNotBefore: s.runNotBefore,
      runAllowed:
        s.runNotBefore !== null &&
        now >= s.runNotBefore &&
        s.runCompletedAt === null,
    },
    run: {
      id: s.runId,
      startedAt: s.runStartedAt,
      by: s.runStartedBy,
      completedAt: s.runCompletedAt,
      productsDone: s.productsDone,
      reportExpiresAt:
        s.runCompletedAt !== null
          ? s.runCompletedAt + OVERRIDE_MIGRATION_REPORT_DAYS * 86_400
          : null,
      columnsEmptiedAt: s.columnsEmptiedAt,
    },
    inventory: s.inventory,
  };
}

/** `?product=` validated against the registry; `undefined` when absent, `null` when unknown. */
async function productParam(
  db: Db,
  url: URL,
): Promise<string | undefined | null> {
  const raw = url.searchParams.get("product");
  if (raw === null || raw === "") return undefined;
  if (!SLUG.test(raw)) return null;
  return (await getProduct(db, raw)) ? raw : null;
}

export async function handleOverrideMigration(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const [sub, ...extra] = rest;
  if (extra.length > 0) return notFound();

  if (sub === undefined) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const product = await productParam(db, url);
    if (product === null) return notFound();
    const state = await readOverrideMigrationState(db);
    const body: Record<string, unknown> = { state: stateView(state, now) };
    if (product !== undefined) {
      const inv = await productOverrideInventory(db, product);
      body.product = {
        slug: product,
        counts: inv.counts,
        licences: inv.licences,
        reportRows: (await listOverrideMigrationReport(db, now, { product }))
          .length,
      };
    }
    return adminJson(body);
  }

  if (sub === "prerequisites") {
    if (req.method !== "PUT")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const body = await readBody(req);
    const changes: Array<[OverrideMigrationPrerequisite, boolean]> = [];
    for (const which of ["loginCard", "library"] as const) {
      const v = body[which];
      if (v === undefined) continue;
      if (typeof v !== "boolean")
        return err(422, ErrorCode.BadRequest, `${which} must be a boolean`, {
          fields: [which],
        });
      changes.push([which, v]);
    }
    if (changes.length === 0)
      return err(422, ErrorCode.BadRequest, "nothing to change", {
        fields: ["loginCard", "library"],
      });
    const before = await readOverrideMigrationState(db);
    for (const [which, live] of changes) {
      const r = await setOverrideMigrationPrerequisite(
        db,
        which,
        live,
        actorOf(session),
        now,
      );
      if (!r.ok)
        return err(
          409,
          "notice_started",
          "The notice has started. Withdraw it before unflagging a prerequisite.",
        );
    }
    const after = await readOverrideMigrationState(db);
    await platformAudit(
      db,
      session,
      now,
      "overrideMigration.prerequisites",
      { kind: "overrideMigration", id: "platform" },
      changes
        .map(
          ([w, live]) =>
            `${w === "loginCard" ? "Login card (I-07)" : "Library (I-11)"} ${live ? "flagged live in production" : "unflagged"}`,
        )
        .join("; "),
      {
        before: {
          loginCard: before.loginCardLiveAt,
          library: before.libraryLiveAt,
        },
        after: {
          loginCard: after.loginCardLiveAt,
          library: after.libraryLiveAt,
        },
      },
    );
    return adminJson({ state: stateView(after, now) });
  }

  if (sub === "notice") {
    if (req.method === "POST") {
      const r = await startOverrideMigrationNotice(db, actorOf(session), now);
      if (!r.ok) {
        if (r.reason === "prerequisites_missing")
          return err(
            409,
            "prerequisites_missing",
            "The notice can't start until the login card (I-07) and the Library (I-11) are both live in production.",
            { missing: r.missing ?? [] },
          );
        return err(
          409,
          r.reason,
          r.reason === "run_started"
            ? "The migration has already run."
            : "The notice has already started.",
        );
      }
      await platformAudit(
        db,
        session,
        now,
        "overrideMigration.notice",
        { kind: "overrideMigration", id: "platform" },
        `Started the licence override migration notice; the run is possible from ${new Date(r.runNotBefore * 1000).toISOString().slice(0, 10)}`,
        { after: { runNotBefore: r.runNotBefore } },
      );
      return adminJson({
        state: stateView(await readOverrideMigrationState(db), now),
      });
    }
    if (req.method === "DELETE") {
      const r = await withdrawOverrideMigrationNotice(db, now);
      if (!r.ok)
        return err(409, "run_started", "The migration has already run.");
      await platformAudit(
        db,
        session,
        now,
        "overrideMigration.notice.withdraw",
        { kind: "overrideMigration", id: "platform" },
        "Withdrew the licence override migration notice",
      );
      return adminJson({
        state: stateView(await readOverrideMigrationState(db), now),
      });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }

  if (sub === "dry-run") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const body = await readBody(req);
    let product: string | undefined;
    if (body.product !== undefined) {
      if (
        typeof body.product !== "string" ||
        !SLUG.test(body.product) ||
        !(await getProduct(db, body.product))
      )
        return notFound();
      product = body.product;
    }
    const result = await dryRunOverrideMigration(db, now, { product });
    return adminJson(result);
  }

  if (sub === "run") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    if (!isSteppedUp(session, now))
      return err(
        403,
        "step_up_required",
        "Sign in again to confirm it's you. Running the migration needs a sign-in from the last 5 minutes.",
        { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
      );
    const before = await readOverrideMigrationState(db);
    const r = await runOverrideMigration(env, db, actorOf(session), now);
    if (!r.ok) {
      const messages: Record<typeof r.reason, string> = {
        notice_not_started:
          "The notice hasn't started. Start it once the login card and the Library are live.",
        notice_window: "The notice window hasn't ended yet.",
        run_completed: "The migration has already run.",
        run_in_progress:
          "Another request is running the migration. Wait a moment and continue.",
      };
      return err(409, r.reason, messages[r.reason], {
        ...(r.runNotBefore !== undefined
          ? { runNotBefore: r.runNotBefore }
          : {}),
      });
    }
    if (before.runId === null)
      await platformAudit(
        db,
        session,
        now,
        "overrideMigration.run",
        { kind: "overrideMigration", id: r.progress.runId },
        "Started the licence override migration: licence config and secrets are frozen",
      );
    if (r.progress.done && before.runCompletedAt === null)
      await platformAudit(
        db,
        session,
        now,
        "overrideMigration.complete",
        { kind: "overrideMigration", id: r.progress.runId },
        "Completed the licence override migration: documents read config and secrets from account overrides only",
      );
    return adminJson({
      progress: r.progress,
      state: stateView(await readOverrideMigrationState(db), now),
    });
  }

  if (sub === "report") {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const product = await productParam(db, url);
    if (product === null) return notFound();
    const rows = await listOverrideMigrationReport(db, now, { product });
    if (url.searchParams.get("format") === "csv") {
      return new Response(overrideMigrationReportCsv(rows), {
        status: 200,
        headers: appSecurityHeaders(
          new Headers({
            "content-type": "text/csv; charset=utf-8",
            "cache-control": "no-store",
            "content-disposition": `attachment; filename="override-migration-report${product ? `-${product}` : ""}.csv"`,
          }),
        ),
      });
    }
    return adminJson({ rows });
  }

  return notFound();
}
