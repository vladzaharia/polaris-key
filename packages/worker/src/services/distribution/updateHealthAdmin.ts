/// <reference types="@cloudflare/workers-types" />

/**
 * The console's update-health surface (P6-03) — `/manage/api/products/<slug>/distribution/
 * update-health…`. Narrative-only, like the rest of the console API; the session, CSRF,
 * rate-limit and platform-admin gates run in `console/api.ts` before this is reached.
 *
 *     GET  …/update-health[?windowHours=N]        the funnel per rollout (offered → downloaded →
 *                                                 applied → confirmed / reverted, plus pack
 *                                                 failures and boot rollbacks, in distinct
 *                                                 devices and in events), the auto-halt settings
 *                                                 and state (last reading, trips, store alerts),
 *                                                 and the Sentry hook's setup and candidates
 *     POST …/update-health/settings               the auto-halt settings: THE ONE WRITER
 *                                                 (`writeAutoHaltSettings`), audited
 *                                                 `distribution.auto_halt.settings`
 *     POST …/update-health/candidates/<id>/confirm  halt the candidate's rollout as this admin
 *     POST …/update-health/candidates/<id>/dismiss  close it without halting
 *
 * The funnel reads `core/updateHealth.ts` `readUpdateHealth` once per (deliverable, release).
 * Counts on an outlet the product does not declare are summed under `unknown` per release, so
 * an operator sees them and nothing can mistake them for a rollout's.
 */

import { ErrorCode } from "../../core/errors.js";
import type { ServiceContext } from "../../core/registry.js";
import type { AdminSession } from "../../core/console/session.js";
import { adminJson, err, readBody } from "../../core/console/respond.js";
import { audit } from "../../core/console/audit.js";
import {
  countsFor,
  readUpdateHealth,
  UPDATE_EVENTS,
  type HealthCount,
} from "../../core/updateHealth.js";
import {
  ALERT_OBJECT,
  AUTO_HALT_CONNECTOR,
  DEFAULT_AUTO_HALT_SETTINGS,
  judge,
  MAX_WINDOW_HOURS,
  patchAutoHaltSettings,
  readAutoHaltSettings,
  READING_OBJECT,
  TRIP_OBJECT,
  writeAutoHaltSettings,
} from "./autoHalt.js";
import { listObjects, objectView } from "./connectors/state.js";
import { listOutlets } from "./outlets.js";
import { listRollouts, rolloutRecord } from "./rollouts.js";
import {
  decideCandidate,
  listCandidates,
  sentryCredentialId,
} from "./sentry.js";

/** The funnel window when none is asked for, and its ceiling (the counters keep 30 days). */
const DEFAULT_FUNNEL_HOURS = 24 * 7;
const MAX_FUNNEL_HOURS = 24 * 30;

export async function handleUpdateHealthAdmin(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response | null> {
  const { req, rest } = ctx;
  if (rest.length === 1) {
    if (req.method !== "GET")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return adminJson(await view(ctx));
  }
  if (rest.length === 2 && rest[1] === "settings") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    return saveSettings(ctx);
  }
  if (
    rest.length === 4 &&
    rest[1] === "candidates" &&
    (rest[3] === "confirm" || rest[3] === "dismiss")
  ) {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    const result = await decideCandidate(
      {
        db: ctx.db,
        product: ctx.product.slug,
        hooks: ctx.hooks,
        now: ctx.now,
      },
      rest[2] as string,
      rest[3],
      ctx.session,
    );
    // A-9: a 404 keeps its `reason` (`unknown_candidate`).
    if (!result.ok)
      return err(
        result.status,
        result.status === 404 ? ErrorCode.NotFound : ErrorCode.BadRequest,
        result.message,
        {
          reason: result.reason,
          ...(result.fields ? { fields: result.fields } : {}),
        },
      );
    return adminJson({ candidate: result.candidate });
  }
  return null;
}

/**
 * The ONE place the auto-halt settings are written: a platform admin's request, validated,
 * stored with the session's subject, and audited. A refused patch writes nothing.
 */
async function saveSettings(
  ctx: ServiceContext & { session: AdminSession },
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  const body = await readBody(req);
  const current = await readAutoHaltSettings(db, product.slug);
  const patched = patchAutoHaltSettings(current, body);
  if (!patched.ok)
    return err(422, ErrorCode.BadRequest, patched.message, {
      reason: "invalid_body",
      fields: [patched.field],
    });
  const s = patched.settings;
  await writeAutoHaltSettings(db, product.slug, s, session.sub, now);
  await audit(
    db,
    product.slug,
    session,
    now,
    "distribution.auto_halt.settings",
    { kind: "auto-halt", id: "settings" },
    `Set the update-telemetry auto-halt: ${
      s.enabled
        ? `on (last ${s.windowHours} h, at least ${s.minSample} devices applied, revert rate > ${s.maxRevertRate}, boot rollback rate > ${s.maxBootRollbackRate})`
        : "off"
    }`,
  );
  return adminJson({ settings: await readAutoHaltSettings(db, product.slug) });
}

function windowOf(req: Request): number {
  const raw = new URL(req.url).searchParams.get("windowHours");
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= MAX_FUNNEL_HOURS
    ? n
    : DEFAULT_FUNNEL_HOURS;
}

async function view(ctx: ServiceContext & { session: AdminSession }) {
  const { req, env, db, product, now } = ctx;
  const slug = product.slug;
  const windowHours = windowOf(req);
  const settings = await readAutoHaltSettings(db, slug);
  const declared = new Set(
    (await listOutlets(db, slug))
      .filter((o) => o.removed_at === null)
      .map((o) => o.outlet_id),
  );
  const rows = await listRollouts(db, slug);

  const reads = new Map<
    string,
    { counts: HealthCount[]; truncated: boolean } | null
  >();
  const readFor = async (deliverable: string, release: string) => {
    const key = `${deliverable}|${release}`;
    if (!reads.has(key))
      reads.set(
        key,
        await readUpdateHealth(env, {
          product: slug,
          deliverable,
          release,
          windowHours,
          now,
        }),
      );
    return reads.get(key) ?? null;
  };

  const rollouts = [];
  for (const row of rows) {
    const read = await readFor(row.deliverable_id, row.release_id);
    const devices = read
      ? countsFor(read.counts, row.outlet_id, row.channel)
      : null;
    const events = read
      ? countsFor(read.counts, row.outlet_id, row.channel, "events")
      : null;
    rollouts.push({
      rollout: rolloutRecord(row),
      devices,
      events,
      truncated: read?.truncated ?? false,
      verdict: devices
        ? judge(
            {
              applied: devices.update_applied,
              reverted: devices.update_reverted,
              bootRolledBack: devices.boot_rolled_back,
            },
            settings,
          )
        : null,
    });
  }

  // Counts on an outlet the product does not declare, per release: shown, never judged.
  const unknown = [];
  for (const [key, read] of reads) {
    if (!read) continue;
    const [deliverable, releaseId] = key.split("|") as [string, string];
    const totals = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, 0]));
    let any = false;
    for (const c of read.counts) {
      if (declared.has(c.outlet)) continue;
      if (c.event in totals) {
        totals[c.event] = (totals[c.event] ?? 0) + c.devices;
        any = true;
      }
    }
    if (any)
      unknown.push({
        deliverable,
        releaseId,
        outlet: "unknown",
        devices: totals,
      });
  }

  const objects = (
    await listObjects(db, slug, AUTO_HALT_CONNECTOR, {
      types: [TRIP_OBJECT, ALERT_OBJECT, READING_OBJECT],
    })
  ).map(objectView);

  return {
    windowHours,
    counting: env.UPDATE_HEALTH !== undefined,
    events: UPDATE_EVENTS,
    rollouts,
    unknown,
    autoHalt: {
      settings,
      defaults: DEFAULT_AUTO_HALT_SETTINGS,
      maxWindowHours: MAX_WINDOW_HOURS,
      lastReading: objects.find((o) => o.type === READING_OBJECT) ?? null,
      trips: objects.filter((o) => o.type === TRIP_OBJECT),
      alerts: objects.filter((o) => o.type === ALERT_OBJECT),
    },
    sentry: {
      configured: (await sentryCredentialId(db, slug)) !== null,
      candidates: await listCandidates(db, slug),
    },
  };
}
