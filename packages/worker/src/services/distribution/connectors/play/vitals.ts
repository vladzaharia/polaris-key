/**
 * The opt-in vitals auto-halt (P5-03): crash and ANR rates per version code from the Play
 * Developer Reporting API (v1beta1; names verified in notes/S-07-policy-recheck.md row 17), and a
 * halt through the one control path (`controls.ts` `applyPlayControl`) when a staged rollout
 * crosses an operator's threshold on enough users.
 *
 * OFF by default (`policy.ts`): with it off this module makes no Reporting API call and mints no
 * Reporting token. With it on, each connector tick that found an `inProgress` release on a mapped
 * track reads, for each of the two metric sets (`apps/{app}/crashRateMetricSet`,
 * `apps/{app}/anrRateMetricSet`):
 *
 *     GET  …/<set>          → freshnessInfo: the latest HOURLY end time Google has (UTC)
 *     POST …/<set>:query    → HOURLY rows over [end − windowHours, end), sliced by versionCode,
 *                             metrics <rate> + distinctUsers (rate: userPerceivedCrashRate /
 *                             userPerceivedAnrRate, or crashRate / anrRate when metric = "all")
 *
 * HOURLY is UTC and has no weighted metrics (row 17), which is why the window is read hour by
 * hour: per release (all its version codes), the rate is the user-weighted mean of the hourly
 * rates and the sample is the sum of hourly `distinctUsers` (an upper bound on distinct users —
 * Google warns the count does not add across periods — so the minimum sample is a floor on
 * user-hours, documented as such).
 *
 * A release trips when its sample is at least `minDistinctUsers` and its crash rate is above
 * `crashRateThreshold` or its ANR rate above `anrRateThreshold`. A trip halts it through
 * `applyPlayControl` with actor `connector:play-vitals` (one `distribution.play.halt` audit row
 * naming the reading), and leaves a `vitals-trip` connector object, so a release trips ONCE:
 * Play may take hours to show the halt (a re-read can still say `inProgress`), and an operator
 * who resumes a tripped release has overruled the auto-halt — it does not fight them.
 */

import type { ControlResult } from "./controls.js";
import { applyPlayControl } from "./controls.js";
import { getObject, upsertObject } from "../state.js";
import { PlayError } from "./client.js";
import type { PlayTrack } from "./map.js";
import type { PlayVitalsSettings } from "./policy.js";
import { errorLine, type PlayRun } from "./run.js";
import {
  PLAY_CONNECTOR,
  PLAY_VITALS_LABEL,
  PLAY_VITALS_SOURCE,
} from "./setup.js";

export const VITALS_TRIP_OBJECT = "vitals-trip";
export const VITALS_READING_OBJECT = "vitals";

/** At most this many pages of rows per query (1000 rows a page). */
const MAX_PAGES = 5;
const PAGE_SIZE = 1000;

type MetricSet = "crash" | "anr";

const SET_RESOURCE: Record<MetricSet, string> = {
  crash: "crashRateMetricSet",
  anr: "anrRateMetricSet",
};

export function rateMetric(
  set: MetricSet,
  metric: PlayVitalsSettings["metric"],
): string {
  if (set === "crash")
    return metric === "all" ? "crashRate" : "userPerceivedCrashRate";
  return metric === "all" ? "anrRate" : "userPerceivedAnrRate";
}

/** A `google.type.DateTime` at a whole UTC hour. */
interface GoogleDateTime {
  year: number;
  month: number;
  day: number;
  hours: number;
  timeZone: { id: "UTC" };
}

function toDateTime(epochSeconds: number): GoogleDateTime {
  const d = new Date(epochSeconds * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hours: d.getUTCHours(),
    timeZone: { id: "UTC" },
  };
}

/** A DateTime Google sent → epoch seconds, or `null` unless it is a UTC instant. */
export function fromDateTime(v: unknown): number | null {
  if (!v || typeof v !== "object") return null;
  const t = v as Record<string, unknown>;
  const tz = t.timeZone as { id?: unknown } | undefined;
  const utc =
    (tz?.id === "UTC" || tz?.id === "Etc/UTC") &&
    (t.utcOffset === undefined || t.utcOffset === "0s");
  const num = (x: unknown, d: number) =>
    x === undefined
      ? d
      : typeof x === "number" && Number.isInteger(x)
        ? x
        : NaN;
  const y = num(t.year, NaN);
  const mo = num(t.month, NaN);
  const da = num(t.day, NaN);
  const h = num(t.hours, 0);
  if (!utc || [y, mo, da, h].some((n) => Number.isNaN(n))) return null;
  return Math.floor(Date.UTC(y, mo - 1, da, h) / 1000);
}

/** The latest HOURLY end time a metric set has data for, or `null`. */
export function hourlyFreshness(doc: unknown): number | null {
  const fresh = (doc as { freshnessInfo?: { freshnesses?: unknown } } | null)
    ?.freshnessInfo?.freshnesses;
  if (!Array.isArray(fresh)) return null;
  for (const f of fresh) {
    if (
      f &&
      typeof f === "object" &&
      (f as { aggregationPeriod?: unknown }).aggregationPeriod === "HOURLY"
    )
      return fromDateTime((f as { latestEndTime?: unknown }).latestEndTime);
  }
  return null;
}

function decimal(v: unknown): number | null {
  const s = (v as { value?: unknown } | null)?.value;
  if (typeof s !== "string") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Per version code: Σ rate×users and Σ users over the rows. */
export interface CodeTally {
  weighted: number;
  users: number;
}

/** Fold one page of query rows into `tally` (only the codes in `codes`). */
export function tallyRows(
  doc: unknown,
  rate: string,
  codes: ReadonlySet<string>,
  tally: Map<string, CodeTally>,
): void {
  const rows = (doc as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as { dimensions?: unknown; metrics?: unknown };
    const dim = Array.isArray(r.dimensions)
      ? (r.dimensions as Array<Record<string, unknown>>).find(
          (d) => d && d.dimension === "versionCode",
        )
      : undefined;
    const code =
      typeof dim?.int64Value === "string"
        ? dim.int64Value
        : typeof dim?.stringValue === "string"
          ? dim.stringValue
          : null;
    if (!code || !codes.has(code)) continue;
    const metrics = Array.isArray(r.metrics)
      ? (r.metrics as Array<Record<string, unknown>>)
      : [];
    const value = (name: string) =>
      decimal(metrics.find((m) => m && m.metric === name)?.decimalValue);
    const users = value("distinctUsers");
    const rateValue = value(rate);
    if (users === null || rateValue === null || users <= 0) continue;
    const t = tally.get(code) ?? { weighted: 0, users: 0 };
    t.weighted += rateValue * users;
    t.users += users;
    tally.set(code, t);
  }
}

/** Read one metric set's per-code tally over the window, or `null` when Google has no hourly
 *  freshness to anchor it (nothing to judge — never a trip). */
async function readSet(
  run: PlayRun,
  set: MetricSet,
  settings: PlayVitalsSettings,
  codes: ReadonlySet<string>,
): Promise<{ tally: Map<string, CodeTally>; end: number } | null> {
  const api = run.reporting();
  const resource = SET_RESOURCE[set];
  const meta = await api.request("GET", [resource], `vitals.${set}rate.get`);
  const end = hourlyFreshness(meta);
  if (end === null) return null;
  const start = end - settings.windowHours * 3600;
  const rate = rateMetric(set, settings.metric);
  const tally = new Map<string, CodeTally>();
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const doc = await api.request(
      "POST",
      [resource],
      `vitals.${set}rate.query`,
      {
        custom: "query",
        body: {
          timelineSpec: {
            aggregationPeriod: "HOURLY",
            startTime: toDateTime(start),
            endTime: toDateTime(end),
          },
          dimensions: ["versionCode"],
          metrics: [rate, "distinctUsers"],
          pageSize: PAGE_SIZE,
          ...(pageToken ? { pageToken } : {}),
        },
      },
    );
    tallyRows(doc, rate, codes, tally);
    const next = (doc as { nextPageToken?: unknown } | null)?.nextPageToken;
    if (typeof next !== "string" || next === "") break;
    pageToken = next;
  }
  return { tally, end };
}

/** One release's reading: users and the user-weighted rate across its version codes. */
export function releaseReading(
  codes: readonly string[],
  tally: ReadonlyMap<string, CodeTally>,
): { users: number; rate: number | null } {
  let weighted = 0;
  let users = 0;
  for (const c of codes) {
    const t = tally.get(c);
    if (t) {
      weighted += t.weighted;
      users += t.users;
    }
  }
  return { users, rate: users > 0 ? weighted / users : null };
}

export interface VitalsOutcome {
  /** Whether the Reporting API was read this tick. */
  ran: boolean;
  /** Releases halted this tick. */
  halted: number;
  error?: string;
}

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;

/**
 * The vitals step of one tick. Never throws: a Reporting failure is this tick's `error` and halts
 * nothing; a halt Google refuses is retried next tick (no trip marker was written).
 */
export async function runVitals(
  run: PlayRun,
  tracks: readonly PlayTrack[],
  settings: PlayVitalsSettings,
): Promise<VitalsOutcome> {
  if (!settings.enabled) return { ran: false, halted: 0 };
  const ctx = { db: run.db, product: run.product, now: run.now };
  // The staged rollouts on mapped tracks that have not tripped before.
  const candidates: Array<{
    track: string;
    codes: string[];
    name: string | null;
  }> = [];
  for (const t of tracks) {
    if (!run.setup.routes.has(t.track)) continue;
    for (const r of t.releases) {
      if (r.status !== "inProgress" || r.versionCodes.length === 0) continue;
      const id = tripId(t.track, r.versionCodes);
      if (
        await getObject(
          run.db,
          run.product,
          PLAY_CONNECTOR,
          VITALS_TRIP_OBJECT,
          id,
        )
      )
        continue;
      candidates.push({ track: t.track, codes: r.versionCodes, name: r.name });
    }
  }
  if (candidates.length === 0) return { ran: false, halted: 0 };
  const codes = new Set(candidates.flatMap((c) => c.codes));

  let crash: Awaited<ReturnType<typeof readSet>>;
  let anr: Awaited<ReturnType<typeof readSet>>;
  try {
    crash = await readSet(run, "crash", settings, codes);
    anr = await readSet(run, "anr", settings, codes);
  } catch (e) {
    return { ran: true, halted: 0, error: `vitals: ${errorLine(e)}` };
  }

  const readings = candidates.map((c) => {
    const cr = crash ? releaseReading(c.codes, crash.tally) : null;
    const an = anr ? releaseReading(c.codes, anr.tally) : null;
    const over = (
      r: { users: number; rate: number | null } | null,
      threshold: number,
    ) =>
      r !== null &&
      r.rate !== null &&
      r.users >= settings.minDistinctUsers &&
      r.rate > threshold;
    const trips: string[] = [];
    if (over(cr, settings.crashRateThreshold))
      trips.push(
        `${rateMetric("crash", settings.metric)} ${pct(cr!.rate!)} over ${cr!.users} user-hours > ${pct(settings.crashRateThreshold)}`,
      );
    if (over(an, settings.anrRateThreshold))
      trips.push(
        `${rateMetric("anr", settings.metric)} ${pct(an!.rate!)} over ${an!.users} user-hours > ${pct(settings.anrRateThreshold)}`,
      );
    return { ...c, crash: cr, anr: an, trips };
  });

  await upsertObject(ctx, PLAY_CONNECTOR, {
    type: VITALS_READING_OBJECT,
    id: "last",
    outletId: null,
    releaseId: null,
    buildId: "",
    storeState: null,
    state: null,
    ref: {},
    detail: {
      at: run.now,
      windowHours: settings.windowHours,
      metric: settings.metric,
      crashEnd: crash?.end ?? null,
      anrEnd: anr?.end ?? null,
      releases: readings.map((r) => ({
        track: r.track,
        versionCodes: r.codes,
        crash: r.crash,
        anr: r.anr,
        tripped: r.trips.length > 0,
      })),
    },
    terminal: false,
  });

  let halted = 0;
  const errors: string[] = [];
  for (const r of readings) {
    if (r.trips.length === 0) continue;
    const reason = `${r.trips.join("; ")} in the last ${settings.windowHours} h (source: ${PLAY_VITALS_SOURCE})`;
    let result: ControlResult;
    try {
      result = await applyPlayControl(run, {
        verb: "halt",
        track: r.track,
        versionCode: r.codes[0]!,
        actor: {
          kind: "system",
          source: PLAY_VITALS_SOURCE,
          label: PLAY_VITALS_LABEL,
        },
        reason,
      });
    } catch (e) {
      if (!(e instanceof PlayError)) throw e;
      errors.push(`vitals halt of ${r.track}: ${e.message}`);
      continue;
    }
    // A refusal decided before the PATCH (the release is no longer staged) halts nothing and
    // marks nothing; the next tick sees what Play says.
    if (!result.ok) continue;
    await upsertObject(ctx, PLAY_CONNECTOR, {
      type: VITALS_TRIP_OBJECT,
      id: tripId(r.track, r.codes),
      outletId: run.setup.routes.get(r.track)?.[0]?.outletId ?? null,
      releaseId: null,
      buildId: "",
      storeState: "halted",
      state: "halted",
      ref: { track: r.track, versionCodes: r.codes },
      detail: { at: run.now, reason, crash: r.crash, anr: r.anr },
      terminal: true,
    });
    halted++;
  }
  return {
    ran: true,
    halted,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

function tripId(track: string, codes: readonly string[]): string {
  return `${track}:${[...codes].sort().join(",")}`;
}
