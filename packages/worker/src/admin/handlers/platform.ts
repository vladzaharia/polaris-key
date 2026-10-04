/**
 * The Platform section's admin API (notes/S-13 §9.2): instance-wide, product-less, read-only so
 * far except the settings store. Platform-admin gated here (403 otherwise), on top of the dispatcher's session gate,
 * limiter and CSRF check.
 *
 *   GET /api/platform/version     — build identity (A-11). Cheap: the SPA's skew check calls it.
 *   GET /api/platform/deployment  — identity plus deploy history (`platform_deploys`, keyset
 *                                   `beforeAt`/`beforeId`/`limit`), D1 migrations applied vs the
 *                                   build's newest, missing required indexes, binding presence
 *                                   (A-11).
 *   GET /api/platform/activity    — `platform_audit`, keyset-paginated, newest first (A-12).
 *   GET/PATCH/DELETE /api/platform/settings[/:key]
 *                                 — the platform settings store and the read-only inventory
 *                                   (A-13, `platformSettings.ts`).
 *
 * Admin routes are narrative-only under AGENTS.md rule 10 (`adminApi` in routeCoverage's
 * NARRATIVE_ONLY): no OpenAPI entry. Nothing here is secret (THREAT-MODEL "Platform settings and
 * operations"): binding presence is a boolean, never an id.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { isPlatformAdmin } from "../authz.js";
import type { AdminSession } from "../session.js";
import {
  AdminBodyError,
  adminJson,
  err,
  forbidden,
  notFound,
} from "../lib/respond.js";
import { handlePlatformSettings } from "./platformSettings.js";
import {
  appliedMigrations,
  deployIdentity,
  LATEST_MIGRATION,
} from "../../core/deployIdentity.js";
import { consoleEnvironment } from "./me.js";
import { missingRequiredIndexes } from "../../scheduled.js";
import { listPlatformAudit, listPlatformDeploys } from "../../repo.js";

/** The bindings the Deployment page lists. Presence only. */
const BINDINGS = [
  "DB",
  "HOT",
  "RL",
  "UPDATE_HEALTH",
  "BLOBS",
  "DELTA_QUEUE",
  "EMAIL",
  "ASSETS",
  "CF_VERSION_METADATA",
] as const;

interface Cursor {
  beforeAt?: number;
  beforeId?: string;
  limit: number;
}

function cursorOf(url: URL, defaultLimit: number, maxLimit: number): Cursor {
  const beforeAt = Number(url.searchParams.get("beforeAt"));
  const beforeId = url.searchParams.get("beforeId");
  const rawLimit = Math.trunc(Number(url.searchParams.get("limit")));
  const limit = rawLimit >= 1 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  return Number.isFinite(beforeAt) &&
    url.searchParams.has("beforeAt") &&
    beforeId
    ? { beforeAt, beforeId, limit }
    : { limit };
}

function parseJson(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function identity(env: Env) {
  return { ...deployIdentity(env), environment: consoleEnvironment(env) };
}

async function deployment(req: Request, env: Env, db: Db): Promise<Response> {
  const cursor = cursorOf(new URL(req.url), 20, 100);
  const [applied, missingIndexes, rows] = await Promise.all([
    appliedMigrations(db),
    missingRequiredIndexes(db).catch(() => null),
    listPlatformDeploys(db, cursor),
  ]);
  const record = env as unknown as Record<string, unknown>;
  const items = rows.map((r) => ({
    id: r.id,
    at: r.at,
    environment: r.environment,
    tag: r.tag,
    gitSha: r.git_sha,
    runUrl: r.run_url,
    scripts: (() => {
      const v = parseJson(r.scripts);
      return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
    })(),
    latestMigration: r.latest_migration,
    cloudflareVersionId: r.cf_version_id,
    deltasVersionId: r.deltas_version_id,
    smoke: r.smoke,
  }));
  const last = rows[rows.length - 1];
  return adminJson({
    current: identity(env),
    deploys: {
      items,
      nextCursor:
        rows.length >= cursor.limit && last
          ? { beforeAt: last.at, beforeId: last.id }
          : null,
    },
    migrations: {
      latest: LATEST_MIGRATION,
      // `null` = d1_migrations could not be read: unknown, not "none applied".
      applied,
      upToDate:
        applied === null
          ? null
          : applied.some((m) => m.name === LATEST_MIGRATION),
    },
    indexes: { missing: missingIndexes },
    bindings: Object.fromEntries(
      BINDINGS.map((name) => [name, record[name] != null]),
    ),
  });
}

async function activity(req: Request, db: Db): Promise<Response> {
  const cursor = cursorOf(new URL(req.url), 50, 200);
  const rows = await listPlatformAudit(db, cursor);
  const items = rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: {
      sub: r.actor_sub ?? "",
      name: r.actor_name ?? "",
      email: r.actor_email ?? "",
    },
    action: r.action,
    target: r.target_kind
      ? { kind: r.target_kind, id: r.target_id ?? "" }
      : null,
    summary: r.summary ?? "",
    before: parseJson(r.before_json),
    after: parseJson(r.after_json),
  }));
  const last = rows[rows.length - 1];
  return adminJson({
    items,
    nextCursor:
      rows.length >= cursor.limit && last
        ? { beforeAt: last.at, beforeId: last.id }
        : null,
  });
}

export async function handlePlatform(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  rest: string[],
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  if (!isPlatformAdmin(env, session))
    return forbidden("platform admin required");
  if (rest[0] === "settings") {
    try {
      return await handlePlatformSettings(
        req,
        env,
        db,
        session,
        rest.slice(1),
        now,
      );
    } catch (e) {
      if (e instanceof AdminBodyError)
        return err(e.status, e.code, e.message, e.extra);
      throw e;
    }
  }
  if (rest.length !== 1) return notFound();
  const [resource] = rest;
  if (
    resource !== "version" &&
    resource !== "deployment" &&
    resource !== "activity"
  )
    return notFound();
  if (req.method !== "GET")
    return err(405, "method_not_allowed", "method not allowed");
  if (resource === "version") return adminJson(identity(env));
  if (resource === "deployment") return deployment(req, env, db);
  return activity(req, db);
}
