/**
 * The telemetry auto-halt (P6-03, README §3.9): Distribution halts a self-hosted outlet rollout
 * when the update outcome events its devices report cross an operator's threshold on enough
 * devices.
 *
 * ── SETTINGS (operator-owned, OFF by default) ───────────────────────────────────────────────
 *
 * Stored per product in `dist_connector_settings` under the connector name `auto-halt` (P5-03's
 * table; one JSON object). Written ONLY by the console's audited control
 * (`updateHealthAdmin.ts`, `POST …/distribution/update-health/settings`: platform-admin session,
 * CSRF, rate limit, one `distribution.auto_halt.settings` audit row with the session's subject).
 * No ingest, resync or manifest field reaches them — a repo push can never switch on an
 * automatic halt (`test/autoHalt.test.ts` pins the writer's reach).
 *
 *     enabled               false
 *     windowHours           6      the last N whole hours, up to and including this one
 *     minSample             200    distinct devices that APPLIED the release on that outlet and
 *                                  channel in the window; below it nothing is judged
 *     maxRevertRate         0.05   update_reverted devices / update_applied devices
 *     maxBootRollbackRate   0.02   boot_rolled_back devices / update_applied devices
 *
 * Reading never fails: a missing row, unparsable JSON or a field out of range reads as that
 * field's default, and the defaults are the safe ones (off).
 *
 * ── THE TICK (`runAutoHalt`, on the connector cron) ──────────────────────────────────────────
 *
 * With it off: nothing is read. With it on, for every `active` rollout of the product:
 *
 *   1. Read its release's counters (`core/updateHealth.ts` `readUpdateHealth`) for the window,
 *      for exactly the rollout's outlet and channel. Counts are DISTINCT DEVICES, so one device
 *      moves a rate by at most one. Events on an outlet the product does not declare never match
 *      a rollout row (a row's outlet is a declared one), so an unknown outlet can never trip.
 *      No data (no binding, a failed read) judges nothing.
 *   2. Below `minSample` applied devices: nothing happens.
 *   3. A rate above its threshold TRIPS:
 *        - a self-hosted (`mirrored = 0`) rollout is halted through P2b-04's one implementation
 *          (`rollouts.ts` `applyRollout`) with the halt-only system actor — `source: auto-halt`,
 *          `updated_by: system:auto-halt`, ONE `distribution.rollout.halt` audit row whose
 *          summary names the numbers;
 *        - a store rollout (`mirrored = 1`) is NEVER halted here: halting it is a connector
 *          control on the store, so the tick only records an `alert` (and one
 *          `distribution.auto_halt.alert` audit row) for an operator.
 *      Either way a `trip` marker is written, so a release trips ONCE per outlet and channel:
 *      an operator who resumes a tripped rollout has overruled the auto-halt, and it does not
 *      fight them. Nothing here ever resumes, ramps, completes or starts a rollout.
 *
 * State lives in `dist_connector_objects` (connector `auto-halt`): `trip` and `alert` markers,
 * and one `reading` (`last`) with every rollout judged on the last tick, which the console shows.
 */

import type { Db } from "../../core/platform.js";
import type { ServiceHooks } from "../../core/hooks.js";
import type { Env } from "../../core/platform.js";
import { countsFor, readUpdateHealth } from "../../core/updateHealth.js";
import { applyRollout, listRollouts, type DistRolloutRow } from "./rollouts.js";
import {
  readConnectorSettings,
  writeConnectorSettings,
} from "./connectors/settings.js";
import { auditConnector, getObject, upsertObject } from "./connectors/state.js";

export const AUTO_HALT_CONNECTOR = "auto-halt";
export const AUTO_HALT_SOURCE = "auto-halt" as const;
export const AUTO_HALT_LABEL = "Auto-halt (update telemetry)";
export const TRIP_OBJECT = "trip";
export const ALERT_OBJECT = "alert";
export const READING_OBJECT = "reading";
export const REFUSAL_OBJECT = "refusal";

// ── Settings ─────────────────────────────────────────────────────────────────────────────────

export interface AutoHaltSettings {
  enabled: boolean;
  windowHours: number;
  minSample: number;
  maxRevertRate: number;
  maxBootRollbackRate: number;
}

export const MAX_WINDOW_HOURS = 168;

export const DEFAULT_AUTO_HALT_SETTINGS: AutoHaltSettings = {
  enabled: false,
  windowHours: 6,
  minSample: 200,
  maxRevertRate: 0.05,
  maxBootRollbackRate: 0.02,
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isRate = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1;
const isWindow = (v: unknown): v is number =>
  typeof v === "number" &&
  Number.isInteger(v) &&
  v >= 1 &&
  v <= MAX_WINDOW_HOURS;
const isSample = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

const CHECKS: Record<
  keyof AutoHaltSettings,
  [(v: unknown) => boolean, string]
> = {
  enabled: [(v) => typeof v === "boolean", "must be a boolean"],
  windowHours: [isWindow, `must be an integer from 1 to ${MAX_WINDOW_HOURS}`],
  minSample: [isSample, "must be a positive integer"],
  maxRevertRate: [isRate, "must be a number strictly between 0 and 1"],
  maxBootRollbackRate: [isRate, "must be a number strictly between 0 and 1"],
};

/** Normalise a stored object: every field present and in range, defaults elsewhere. */
export function normalizeAutoHaltSettings(raw: unknown): AutoHaltSettings {
  const d = DEFAULT_AUTO_HALT_SETTINGS;
  const o = isObj(raw) ? raw : {};
  return {
    enabled: o.enabled === true,
    windowHours: isWindow(o.windowHours) ? o.windowHours : d.windowHours,
    minSample: isSample(o.minSample) ? o.minSample : d.minSample,
    maxRevertRate: isRate(o.maxRevertRate) ? o.maxRevertRate : d.maxRevertRate,
    maxBootRollbackRate: isRate(o.maxBootRollbackRate)
      ? o.maxBootRollbackRate
      : d.maxBootRollbackRate,
  };
}

export async function readAutoHaltSettings(
  db: Db,
  product: string,
): Promise<
  AutoHaltSettings & { updatedAt: number | null; updatedBy: string | null }
> {
  const row = await readConnectorSettings(db, product, AUTO_HALT_CONNECTOR);
  return {
    ...normalizeAutoHaltSettings(row?.value),
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row?.updatedBy ?? null,
  };
}

export type AutoHaltPatchResult =
  | { ok: true; settings: AutoHaltSettings }
  | { ok: false; field: string; message: string };

/** Apply a partial update. Every given field must be valid; an unknown field is refused, so a
 *  typo never reads as "saved". */
export function patchAutoHaltSettings(
  current: AutoHaltSettings,
  body: Record<string, unknown>,
): AutoHaltPatchResult {
  const next: AutoHaltSettings = {
    enabled: current.enabled,
    windowHours: current.windowHours,
    minSample: current.minSample,
    maxRevertRate: current.maxRevertRate,
    maxBootRollbackRate: current.maxBootRollbackRate,
  };
  for (const [k, v] of Object.entries(body)) {
    const check = CHECKS[k as keyof AutoHaltSettings];
    if (!check) return { ok: false, field: k, message: `unknown setting ${k}` };
    if (!check[0](v))
      return { ok: false, field: k, message: `${k} ${check[1]}` };
    (next as unknown as Record<string, unknown>)[k] = v;
  }
  return { ok: true, settings: next };
}

/**
 * Store validated settings. Its ONE caller is the console's audited control
 * (`updateHealthAdmin.ts`); `test/autoHalt.test.ts` refuses any other file that names it.
 */
export async function writeAutoHaltSettings(
  db: Db,
  product: string,
  settings: AutoHaltSettings,
  by: string,
  now: number,
): Promise<void> {
  await writeConnectorSettings(
    db,
    product,
    AUTO_HALT_CONNECTOR,
    settings as unknown as Record<string, unknown>,
    by,
    now,
  );
}

// ── Evaluation ───────────────────────────────────────────────────────────────────────────────

/** One rollout's numbers over the window. Counts are distinct devices. */
export interface RolloutReading {
  deliverable: string;
  outlet: string;
  channel: string;
  releaseId: string;
  mirrored: boolean;
  /** `null` = no data could be read; nothing was judged. */
  applied: number | null;
  reverted: number | null;
  bootRolledBack: number | null;
  revertRate: number | null;
  bootRollbackRate: number | null;
  /** Why it tripped, empty when it did not. */
  trips: string[];
  /** Why nothing was judged: `no-data` (the counters could not be read) or `truncated` (the
   *  read hit its key ceiling, so its sums are incomplete). */
  skipped?: "no-data" | "truncated";
  /** A halt the rollout code refused this tick (a race: the rollout moved since it was listed);
   *  judged again next tick. */
  refused?: string;
}

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;

/** Judge one rollout's counts against the settings. Pure. */
export function judge(
  counts: { applied: number; reverted: number; bootRolledBack: number },
  settings: AutoHaltSettings,
): {
  revertRate: number | null;
  bootRollbackRate: number | null;
  trips: string[];
} {
  const { applied, reverted, bootRolledBack } = counts;
  if (applied <= 0)
    return { revertRate: null, bootRollbackRate: null, trips: [] };
  const revertRate = reverted / applied;
  const bootRollbackRate = bootRolledBack / applied;
  const trips: string[] = [];
  if (applied >= settings.minSample) {
    if (revertRate > settings.maxRevertRate)
      trips.push(
        `revert rate ${pct(revertRate)} (${reverted} of ${applied} devices) > ${pct(settings.maxRevertRate)}`,
      );
    if (bootRollbackRate > settings.maxBootRollbackRate)
      trips.push(
        `boot rollback rate ${pct(bootRollbackRate)} (${bootRolledBack} of ${applied} devices) > ${pct(settings.maxBootRollbackRate)}`,
      );
  }
  return { revertRate, bootRollbackRate, trips };
}

export function tripId(
  r: Pick<
    DistRolloutRow,
    "deliverable_id" | "outlet_id" | "channel" | "release_id"
  >,
): string {
  return `${r.deliverable_id}:${r.outlet_id}:${r.channel}:${r.release_id}`;
}

export interface AutoHaltContext {
  env: Env;
  db: Db;
  product: string;
  hooks: ServiceHooks;
  now: number;
}

export interface AutoHaltOutcome {
  /** Whether counters were read this tick. */
  ran: boolean;
  /** Self-hosted rollouts halted this tick. */
  halted: number;
  /** Store rollouts that crossed a threshold this tick (alert only). */
  alerted: number;
  /** Halts the rollout code refused this tick (recorded on the reading, retried next tick). */
  refused?: number;
  error?: string;
}

/**
 * One auto-halt tick for one product. A halt the rollout code refuses (it moved since it was
 * read) halts nothing, marks nothing and is NOT an error: it is recorded on the reading
 * (`refused`) and the next tick judges it again.
 */
export async function runAutoHalt(
  ctx: AutoHaltContext,
): Promise<AutoHaltOutcome> {
  const { env, db, product, now } = ctx;
  const settings = await readAutoHaltSettings(db, product);
  if (!settings.enabled) return { ran: false, halted: 0, alerted: 0 };
  const rows = (await listRollouts(db, product)).filter(
    (r) => r.state === "active",
  );
  if (rows.length === 0) return { ran: false, halted: 0, alerted: 0 };

  const write = { db, product, now };
  const reads = new Map<string, Awaited<ReturnType<typeof readUpdateHealth>>>();
  const readings: RolloutReading[] = [];
  let halted = 0;
  let alerted = 0;
  let refused = 0;

  for (const row of rows) {
    const key = `${row.deliverable_id}|${row.release_id}`;
    if (!reads.has(key))
      reads.set(
        key,
        await readUpdateHealth(env, {
          product,
          deliverable: row.deliverable_id,
          release: row.release_id,
          windowHours: settings.windowHours,
          now,
        }),
      );
    const read = reads.get(key) ?? null;
    const base = {
      deliverable: row.deliverable_id,
      outlet: row.outlet_id,
      channel: row.channel,
      releaseId: row.release_id,
      mirrored: row.mirrored === 1,
    };
    // No data, or an incomplete sum: judge nothing (a truncated read could hide the very hours
    // that would trip, or the applied devices that would not).
    if (!read || read.truncated) {
      readings.push({
        ...base,
        applied: null,
        reverted: null,
        bootRolledBack: null,
        revertRate: null,
        bootRollbackRate: null,
        trips: [],
        skipped: read ? "truncated" : "no-data",
      });
      continue;
    }
    const c = countsFor(read.counts, row.outlet_id, row.channel);
    const counts = {
      applied: c.update_applied,
      reverted: c.update_reverted,
      bootRolledBack: c.boot_rolled_back,
    };
    const verdict = judge(counts, settings);
    readings.push({ ...base, ...counts, ...verdict });
    if (verdict.trips.length === 0) continue;

    const id = tripId(row);
    if (await getObject(db, product, AUTO_HALT_CONNECTOR, TRIP_OBJECT, id))
      continue;
    const reason = `${verdict.trips.join("; ")} in the last ${settings.windowHours} h (source: ${AUTO_HALT_SOURCE})`;

    if (row.mirrored === 1) {
      // A store's rollout: never halted here. Raise the alert once; the operator halts it with
      // the store connector's own control.
      await upsertObject(write, AUTO_HALT_CONNECTOR, {
        type: ALERT_OBJECT,
        id,
        outletId: row.outlet_id,
        releaseId: row.release_id,
        buildId: "",
        storeState: null,
        state: "alert",
        ref: {
          deliverable: row.deliverable_id,
          channel: row.channel,
          source: row.source,
        },
        detail: { at: now, reason, ...counts, ...verdict },
        terminal: true,
      });
      await upsertObject(write, AUTO_HALT_CONNECTOR, {
        type: TRIP_OBJECT,
        id,
        outletId: row.outlet_id,
        releaseId: row.release_id,
        buildId: "",
        storeState: null,
        state: "alerted",
        ref: { deliverable: row.deliverable_id, channel: row.channel },
        detail: { at: now, reason },
        terminal: true,
      });
      await auditConnector(
        write,
        AUTO_HALT_CONNECTOR,
        AUTO_HALT_LABEL,
        "distribution.auto_halt.alert",
        {
          kind: "rollout",
          id: `${row.deliverable_id}:${row.outlet_id}:${row.channel}`,
        },
        `The ${row.outlet_id} rollout of ${row.release_id} on ${row.channel} crossed the auto-halt threshold but is mirrored from ${row.source}; not halted here — halt it with the ${row.source} connector: ${reason}`,
      );
      alerted++;
      continue;
    }

    const result = await applyRollout(
      { db, product, hooks: ctx.hooks, now },
      "halt",
      {
        outlet: row.outlet_id,
        channel: row.channel,
        deliverable: row.deliverable_id,
        releaseId: row.release_id,
      },
      {
        kind: "system",
        source: AUTO_HALT_SOURCE,
        label: AUTO_HALT_LABEL,
        reason,
      },
    );
    if (!result.ok) {
      // Recorded on the reading and retried next tick; not a tick failure, so the cron does not
      // fail on every tick while the race lasts.
      const reading = readings[readings.length - 1];
      if (reading) reading.refused = result.reason;
      refused++;
      // The FIRST refusal per trip id is audited (and marked), so a halt refused for a lasting
      // reason is visible to the operator without an audit row on every tick.
      if (
        !(await getObject(db, product, AUTO_HALT_CONNECTOR, REFUSAL_OBJECT, id))
      ) {
        await upsertObject(write, AUTO_HALT_CONNECTOR, {
          type: REFUSAL_OBJECT,
          id,
          outletId: row.outlet_id,
          releaseId: row.release_id,
          buildId: "",
          storeState: null,
          state: "refused",
          ref: { deliverable: row.deliverable_id, channel: row.channel },
          detail: { at: now, reason: result.reason, message: result.message },
          terminal: false,
        });
        await auditConnector(
          write,
          AUTO_HALT_CONNECTOR,
          AUTO_HALT_LABEL,
          "distribution.auto_halt.refused",
          {
            kind: "rollout",
            id: `${row.deliverable_id}:${row.outlet_id}:${row.channel}`,
          },
          `The auto-halt tripped on the ${row.outlet_id} rollout of ${row.release_id} on ${row.channel} but the halt was refused (${result.reason}); it retries every tick: ${reason}`,
        );
      }
      continue;
    }
    await upsertObject(write, AUTO_HALT_CONNECTOR, {
      type: TRIP_OBJECT,
      id,
      outletId: row.outlet_id,
      releaseId: row.release_id,
      buildId: "",
      storeState: null,
      state: "halted",
      ref: { deliverable: row.deliverable_id, channel: row.channel },
      detail: { at: now, reason, ...counts, ...verdict },
      terminal: true,
    });
    halted++;
  }

  await upsertObject(write, AUTO_HALT_CONNECTOR, {
    type: READING_OBJECT,
    id: "last",
    outletId: null,
    releaseId: null,
    buildId: "",
    storeState: null,
    state: null,
    ref: {},
    detail: {
      at: now,
      settings: normalizeAutoHaltSettings(settings),
      rollouts: readings,
    },
    terminal: false,
  });

  return { ran: true, halted, alerted, refused };
}
