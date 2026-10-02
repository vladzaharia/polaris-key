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
 * ── STORAGE (all keys `|`-separated; no stored field may contain `|`) ─────────────────────────
 *
 *     e|<device>|<eventId>                         → epoch seconds first seen      (dedupe)
 *     d|<event>|<outlet>|<channel>|<device>        → hour first seen               (distinct)
 *     h|<hour, 8 digits>|<outlet>|<channel>|<event> → {events, devices}            (buckets)
 *     meta|pairs                                   → the (outlet, channel) pairs seen
 *
 * Bounded: at most `MAX_PAIRS` (outlet, channel) pairs; an event on a further pair is counted
 * under `OVERFLOW_OUTLET` / `OVERFLOW_CHANNEL`, so a device cannot mint unbounded bucket keys by
 * inventing outlets or channels. Everything older than `RETENTION_SECONDS` is deleted by the
 * alarm, which re-arms while anything is left and stops once the object is empty.
 */

/** How long counters, dedupe keys and per-device markers are kept (30 days). */
export const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const RETENTION_HOURS = RETENTION_SECONDS / 3600;

/** Distinct (outlet, channel) pairs one release's object tracks before folding into overflow. */
export const MAX_PAIRS = 32;
export const OVERFLOW_OUTLET = "~overflow";
export const OVERFLOW_CHANNEL = "~overflow";

/** Most events one record call may carry (the report allows 16). */
const MAX_RECORD_EVENTS = 16;
/** Most bucket keys one read sums; past it the answer says `truncated`. */
const MAX_READ_KEYS = 20_000;
/** The sweep: how often, and how many keys per prefix per pass. */
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 2000;

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
    const pairs = new Set(
      ((await storage.get<string[]>("meta|pairs")) ?? []).filter(
        (p) => typeof p === "string",
      ),
    );
    const pairsBefore = pairs.size;
    let counted = 0;
    for (const raw of req.events.slice(0, MAX_RECORD_EVENTS)) {
      if (!validEvent(raw)) continue;
      const at = Math.min(raw.at, req.now);
      if (at < req.now - RETENTION_SECONDS) continue;
      const dedupe = `e|${req.deviceId}|${raw.eventId}`;
      if ((await storage.get(dedupe)) !== undefined) continue;
      await storage.put(dedupe, req.now);

      let { outlet, channel } = raw;
      const pair = `${outlet}|${channel}`;
      if (!pairs.has(pair)) {
        if (pairs.size >= MAX_PAIRS) {
          outlet = OVERFLOW_OUTLET;
          channel = OVERFLOW_CHANNEL;
        } else pairs.add(pair);
      }
      const hour = hourOf(at);
      const bucketKey = `h|${pad(hour)}|${outlet}|${channel}|${raw.event}`;
      const bucket = (await storage.get<Bucket>(bucketKey)) ?? {
        events: 0,
        devices: 0,
      };
      bucket.events += 1;
      const deviceKey = `d|${raw.event}|${outlet}|${channel}|${req.deviceId}`;
      if ((await storage.get(deviceKey)) === undefined) {
        await storage.put(deviceKey, hour);
        bucket.devices += 1;
      }
      await storage.put(bucketKey, bucket);
      counted++;
    }
    if (pairs.size !== pairsBefore) await storage.put("meta|pairs", [...pairs]);
    if (counted > 0) await this.ensureSweepScheduled();
    return { counted };
  }

  private async read(req: ReadRequest): Promise<ReadAnswer> {
    if (
      !Number.isInteger(req.sinceHour) ||
      !Number.isInteger(req.untilHour) ||
      req.untilHour < req.sinceHour
    )
      return { counts: [], truncated: false };
    const entries = await this.state.storage.list<Bucket>({
      prefix: "h|",
      start: `h|${pad(req.sinceHour)}`,
      end: `h|${pad(req.untilHour + 1)}`,
      limit: MAX_READ_KEYS,
    });
    const sums = new Map<string, HealthCount>();
    for (const [key, bucket] of entries) {
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
    }
    return {
      counts: [...sums.values()].sort((a, b) =>
        `${a.outlet}|${a.channel}|${a.event}`.localeCompare(
          `${b.outlet}|${b.channel}|${b.event}`,
        ),
      ),
      truncated: entries.size >= MAX_READ_KEYS,
    };
  }

  private async ensureSweepScheduled(): Promise<void> {
    const storage = this.state.storage;
    if (typeof storage.getAlarm !== "function") return;
    if ((await storage.getAlarm()) !== null) return;
    await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
  }

  /**
   * Delete what is past retention: buckets of old hours, dedupe keys and per-device markers
   * first seen before the cutoff. Re-arms while anything is left, so an idle release's object
   * empties itself within a day of its last event turning 30 days old and then costs nothing.
   */
  async alarm(): Promise<void> {
    const storage = this.state.storage;
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - RETENTION_SECONDS;
    const cutoffHour = hourOf(nowSec) - RETENTION_HOURS;
    let full = false;

    const buckets = await storage.list({
      prefix: "h|",
      end: `h|${pad(cutoffHour)}`,
      limit: SWEEP_BATCH,
    });
    if (buckets.size > 0) await storage.delete([...buckets.keys()]);
    full ||= buckets.size === SWEEP_BATCH;

    for (const [prefix, stale] of [
      ["e|", (v: unknown) => typeof v !== "number" || v < cutoffSec],
      ["d|", (v: unknown) => typeof v !== "number" || v < cutoffHour],
    ] as const) {
      const entries = await storage.list({ prefix, limit: SWEEP_BATCH });
      const old = [...entries].filter(([, v]) => stale(v)).map(([k]) => k);
      if (old.length > 0) await storage.delete(old);
      full ||= entries.size === SWEEP_BATCH;
    }

    const left = await storage.list({ prefix: "h|", limit: 1 });
    if (full || left.size > 0) {
      await storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    } else {
      // Nothing countable is left: drop the dedupe keys, markers and pair list with it.
      await storage.deleteAll();
    }
  }
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
