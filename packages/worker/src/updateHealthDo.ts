/// <reference types="@cloudflare/workers-types" />
import type { Env } from "./env.js";

/**
 * Update-health counters (P6-03, README §3.9 "Rollouts, halts and telemetry").
 *
 * One Durable Object per (product, deliverable, release) — `UPDATE_HEALTH.idFromName(
 * "<product>|<deliverable>|<release>")`, named by `core/updateHealth.ts`, the only caller. It
 * counts the update outcome events devices report on `POST /<p>/devices/report` (`updates`),
 * per outlet, channel and event, in hourly buckets, and answers a window's totals.
 *
 * Why a Durable Object: the counters need read-your-writes for the auto-halt tick and no account
 * API token (Analytics Engine needs one to query), and the report path must not write D1.
 *
 * ── WHAT IS COUNTED ─────────────────────────────────────────────────────────────────────────
 *
 * Two numbers per (hour, outlet, channel, event):
 *
 *   - `events`  — distinct events, deduplicated on (device, `eventId`): a retried report, or the
 *                 same event resent in the next report, counts once.
 *   - `devices` — distinct DEVICES, counted in the hour the device first reported that event for
 *                 that outlet and channel. This is what the auto-halt reads: one device can move
 *                 a rate by at most one, however many events it invents.
 *
 * ── WHAT A DEVICE CAN DO TO IT (the bounds) ─────────────────────────────────────────────────
 *
 * The caller has already mapped an outlet the product does not declare, or a channel the
 * product does not know, to the single `UNKNOWN` bucket (`UNKNOWN`, `UNKNOWN`), so the bucket
 * keys are bounded by the operator's declarations, not by what a device invents, and an invented
 * pair can never push a real one anywhere. On top of that, per device and per object:
 *
 *   - at most `MAX_DEVICE_EVENTS` (64) events are ever counted; past it the device counts
 *     nothing more here (its dedupe list is what bounds its record);
 *   - at most `MAX_DEVICE_PAIRS` (8) distinct (outlet, channel) pairs; an event on a further pair
 *     is counted in the `UNKNOWN` bucket.
 *
 * ── STORAGE (all keys `|`-separated; no stored field may contain `|`) ─────────────────────────
 *
 *     v|<device>                                    → {last, ids[], pairs[], seen[]}  (one per device)
 *     h|<hour, 8 digits>|<outlet>|<channel>|<event> → {events, devices}             (buckets)
 *     meta|sweep                                    → the sweep's resume cursor
 *
 * `ids` are the counted `eventId`s (the dedupe list, ≤ 64), `pairs` the device's (outlet,
 * channel) pairs (≤ 8), `seen` the `event|outlet|channel` triples it has been counted under
 * (distinct devices), `last` the epoch second of its last counted event.
 *
 * ── RETENTION ───────────────────────────────────────────────────────────────────────────────
 *
 * The alarm deletes buckets older than `RETENTION_SECONDS` (hour-keyed, so a range from the
 * start) and device records whose `last` is older than that (a full scan, paginated with a
 * `startAfter` cursor). It works until done or until `SWEEP_BUDGET_MS` is spent; with work left
 * it saves the cursor and re-arms in `SWEEP_RESUME_MS` (a minute), otherwise in a day while
 * anything is left, and deletes the object's storage entirely once it is empty.
 */

/** How long counters and device records are kept (30 days). */
export const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const RETENTION_HOURS = RETENTION_SECONDS / 3600;

/** The one bucket for an undeclared outlet, an unknown channel, or a device past its pair cap. */
export const UNKNOWN = "~unknown";
/** Events one device may ever have counted in one release's object. */
export const MAX_DEVICE_EVENTS = 64;
/** (outlet, channel) pairs one device may introduce in one release's object. */
export const MAX_DEVICE_PAIRS = 8;

/** Most events one record call may carry (the report allows 16). */
const MAX_RECORD_EVENTS = 16;
/** Keys read per page, and a hard ceiling past which a read says `truncated` (a reader must then
 *  treat the answer as no data). With outlets and channels bounded by declarations this is far
 *  above anything a product reaches: 720 hours × pairs × 7 events. */
const READ_PAGE = 1000;
export const MAX_READ_KEYS = 500_000;
/** The sweep. */
export const SWEEP_BATCH = 2000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SWEEP_RESUME_MS = 60 * 1000;
export const SWEEP_BUDGET_MS = 10_000;

/** One event as `core/updateHealth.ts` hands it over: already validated and bounded. */
export interface HealthEvent {
  eventId: string;
  event: string;
  outlet: string;
  channel: string;
  /** Epoch seconds, already clamped to [now − retention, now]. */
  at: number;
}

export interface RecordRequest {
  op: "record";
  now: number;
  deviceId: string;
  events: HealthEvent[];
}

export interface ReadRequest {
  op: "read";
  /** Inclusive epoch hours. */
  sinceHour: number;
  untilHour: number;
}

export interface HealthCount {
  outlet: string;
  channel: string;
  event: string;
  events: number;
  devices: number;
}

export interface ReadAnswer {
  counts: HealthCount[];
  truncated: boolean;
}

interface Bucket {
  events: number;
  devices: number;
}

interface DeviceRecord {
  last: number;
  ids: string[];
  pairs: string[];
  seen: string[];
}

const SAFE = /^[^|]{1,200}$/;

export const hourOf = (epochSeconds: number): number =>
  Math.floor(epochSeconds / 3600);
const pad = (hour: number): string => String(hour).padStart(8, "0");

function validEvent(e: unknown): e is HealthEvent {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return (
    ["eventId", "event", "outlet", "channel"].every(
      (k) => typeof v[k] === "string" && SAFE.test(v[k] as string),
    ) &&
    typeof v.at === "number" &&
    Number.isFinite(v.at)
  );
}

function deviceRecord(raw: unknown): DeviceRecord {
  const r = (raw ?? {}) as Partial<DeviceRecord>;
  const strs = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    last: typeof r.last === "number" ? r.last : 0,
    ids: strs(r.ids),
    pairs: strs(r.pairs),
    seen: strs(r.seen),
  };
}

export class UpdateHealthDO implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return answer({ error: "bad_request" }, 400);
    }
    const op = (body as { op?: unknown } | null)?.op;
    if (op === "record")
      return answer(await this.record(body as RecordRequest));
    if (op === "read") return answer(await this.read(body as ReadRequest));
    return answer({ error: "bad_request" }, 400);
  }

  private async record(req: RecordRequest): Promise<{ counted: number }> {
    const storage = this.state.storage;
    if (
      typeof req.deviceId !== "string" ||
      !SAFE.test(req.deviceId) ||
      typeof req.now !== "number" ||
      !Array.isArray(req.events)
    )
      return { counted: 0 };
    const deviceKey = `v|${req.deviceId}`;
    const device = deviceRecord(await storage.get(deviceKey));
    const ids = new Set(device.ids);
    const pairs = new Set(device.pairs);
    const seen = new Set(device.seen);
    let counted = 0;
    for (const raw of req.events.slice(0, MAX_RECORD_EVENTS)) {
      if (!validEvent(raw)) continue;
      if (ids.size >= MAX_DEVICE_EVENTS) break;
      const at = Math.min(raw.at, req.now);
      if (at < req.now - RETENTION_SECONDS) continue;
      if (ids.has(raw.eventId)) continue;
      ids.add(raw.eventId);

      let { outlet, channel } = raw;
      if (outlet === UNKNOWN || channel === UNKNOWN) {
        outlet = UNKNOWN;
        channel = UNKNOWN;
      } else {
        const pair = `${outlet}|${channel}`;
        if (!pairs.has(pair)) {
          if (pairs.size >= MAX_DEVICE_PAIRS) {
            outlet = UNKNOWN;
            channel = UNKNOWN;
          } else pairs.add(pair);
        }
      }
      const hour = hourOf(at);
      const bucketKey = `h|${pad(hour)}|${outlet}|${channel}|${raw.event}`;
      const bucket = (await storage.get<Bucket>(bucketKey)) ?? {
        events: 0,
        devices: 0,
      };
      bucket.events += 1;
      const triple = `${raw.event}|${outlet}|${channel}`;
      if (!seen.has(triple)) {
        seen.add(triple);
        bucket.devices += 1;
      }
      await storage.put(bucketKey, bucket);
      counted++;
    }
    if (counted > 0) {
      await storage.put(deviceKey, {
        last: req.now,
        ids: [...ids],
        pairs: [...pairs],
        seen: [...seen],
      } satisfies DeviceRecord);
      await this.ensureSweepScheduled();
    }
    return { counted };
  }

  /** Sum every bucket in the window, page by page. */
  private async read(req: ReadRequest): Promise<ReadAnswer> {
    if (
      !Number.isInteger(req.sinceHour) ||
      !Number.isInteger(req.untilHour) ||
      req.untilHour < req.sinceHour
    )
      return { counts: [], truncated: false };
    const sums = new Map<string, HealthCount>();
    const end = `h|${pad(req.untilHour + 1)}`;
    let start = `h|${pad(req.sinceHour)}`;
    let after: string | undefined;
    let read = 0;
    let truncated = false;
    for (;;) {
      const page = await this.state.storage.list<Bucket>({
        prefix: "h|",
        ...(after === undefined ? { start } : { startAfter: after }),
        end,
        limit: READ_PAGE,
      });
      for (const [key, bucket] of page) {
        const [, , outlet, channel, event] = key.split("|");
        if (!outlet || !channel || !event) continue;
        const id = `${outlet}|${channel}|${event}`;
        const sum = sums.get(id) ?? {
          outlet,
          channel,
          event,
          events: 0,
          devices: 0,
        };
        sum.events += bucket?.events ?? 0;
        sum.devices += bucket?.devices ?? 0;
        sums.set(id, sum);
        after = key;
      }
      read += page.size;
      if (page.size < READ_PAGE) break;
      if (read >= MAX_READ_KEYS) {
        truncated = true;
        break;
      }
      start = after ?? start;
    }
    return {
      counts: [...sums.values()].sort((a, b) =>
        `${a.outlet}|${a.channel}|${a.event}`.localeCompare(
          `${b.outlet}|${b.channel}|${b.event}`,
        ),
      ),
      truncated,
    };
  }

  private async ensureSweepScheduled(): Promise<void> {
    const storage = this.state.storage;
    if (typeof storage.getAlarm !== "function") return;
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /**
   * Delete what is past retention, until done or out of budget (see the header). Buckets are
   * hour-keyed, so the stale ones are a prefix of the key space and are deleted batch by batch
   * from the start; device records are scanned with a `startAfter` cursor that survives between
   * alarms, so any number of young records sorting before stale ones cannot stop the sweep.
   */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const startedAt = Date.now();
    const nowSec = Math.floor(startedAt / 1000);
    const cutoffSec = nowSec - RETENTION_SECONDS;
    const cutoffHour = hourOf(nowSec) - RETENTION_HOURS;
    const outOfTime = () => Date.now() - startedAt >= SWEEP_BUDGET_MS;
    let done = false;

    // 1. Buckets older than the cutoff: always a prefix of `h|`.
    let bucketsDone = false;
    while (!outOfTime()) {
      const batch = await storage.list({
        prefix: "h|",
        end: `h|${pad(cutoffHour)}`,
        limit: SWEEP_BATCH,
      });
      if (batch.size > 0) await storage.delete([...batch.keys()]);
      if (batch.size < SWEEP_BATCH) {
        bucketsDone = true;
        break;
      }
    }

    // 2. Device records idle past the cutoff: a cursor-paginated scan.
    let cursor = await storage.get<string>("meta|sweep");
    let devicesDone = false;
    while (bucketsDone && !outOfTime()) {
      const page = await storage.list<unknown>({
        prefix: "v|",
        ...(cursor ? { startAfter: cursor } : {}),
        limit: SWEEP_BATCH,
      });
      const stale: string[] = [];
      for (const [key, value] of page) {
        if (deviceRecord(value).last < cutoffSec) stale.push(key);
        cursor = key;
      }
      if (stale.length > 0) await storage.delete(stale);
      if (page.size < SWEEP_BATCH) {
        devicesDone = true;
        break;
      }
    }
    done = bucketsDone && devicesDone;

    if (!done) {
      if (cursor) await storage.put("meta|sweep", cursor);
      await storage.setAlarm(Date.now() + SWEEP_RESUME_MS);
      return;
    }
    await storage.delete("meta|sweep");
    const left = await storage.list({ limit: 1 });
    if (left.size > 0) await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    else await storage.deleteAll();
  }
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
