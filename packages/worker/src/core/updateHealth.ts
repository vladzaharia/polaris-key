/// <reference types="@cloudflare/workers-types" />

/**
 * Update health (P6-03, README §3.6 "Telemetry" and §3.9): the update outcome events devices
 * report, and the one accessor that reads their counters.
 *
 * Devices put them in the `updates` key of `POST /<p>/devices/report` (`core/devices.ts`): a
 * bounded array of at most `MAX_UPDATE_EVENTS` entries
 *
 *     {eventId, event, deliverable, release, fromRelease?, outlet, channel, packSetId?, at, code?}
 *
 * `boundedUpdates` keeps only well-formed entries of a known `event` (the seven `updateEvent`
 * values of `conformance/parity/enums.json`, fixed by plans/P3-01.md §2.10; `test/updateHealth
 * .test.ts` pins this list to that file) and drops every unknown field. `recordUpdateEvents`
 * counts them in `UpdateHealthDO` (`src/updateHealthDo.ts`), one object per (product,
 * deliverable, release), deduplicated on (device, `eventId`); `readUpdateHealth` answers a
 * window's totals per outlet, channel and event.
 *
 * Where the shape lives: P1-05's precedent for `engine` and `outlet` — this allowlist and the
 * OpenAPI report schema only; `shared-protocol` is untouched (the report is unsigned and the
 * key is optional, so no wire change).
 *
 * Both functions FAIL OPEN and never throw: telemetry must never cost a device its report (the
 * snapshot is stored first), and an unbound `UPDATE_HEALTH` (a deployment without the binding,
 * most tests) counts nothing and reads `null`.
 *
 * Privacy (docs/PRIVACY.md): an event carries release identifiers, an outlet, a channel, a time
 * and an optional short error code — no hardware value and no user identifier beyond the device
 * id the Worker already holds (AGENTS.md rule 7). The object keeps device ids only to count
 * distinct devices, for at most 30 days (`RETENTION_SECONDS`).
 */

import { OUTLET_ID_PATTERN } from "@polaris-key/protocol/distribution";
import type { Env } from "../env.js";
import type { ServiceHooks } from "./hooks.js";
import {
  hourOf,
  RETENTION_SECONDS,
  UNKNOWN,
  type HealthCount,
  type HealthEvent,
  type ReadAnswer,
} from "../updateHealthDo.js";

/** The seven event names (`updateEvent` in `conformance/parity/enums.json`). */
export const UPDATE_EVENTS = [
  "update_offered",
  "update_downloaded",
  "update_applied",
  "update_confirmed",
  "update_reverted",
  "pack_failed",
  "boot_rolled_back",
] as const;
export type UpdateEvent = (typeof UPDATE_EVENTS)[number];

/** At most this many events per report; the rest are dropped. */
export const MAX_UPDATE_EVENTS = 16;

/** One validated event, as the report snapshot stores it. */
export interface UpdateEventEntry {
  eventId: string;
  event: UpdateEvent;
  deliverable: string;
  release: string;
  fromRelease?: string;
  outlet: string;
  channel: string;
  packSetId?: string;
  at: number;
  code?: string;
}

const EVENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** `DELIVERABLE_ID_PATTERN` (@polaris-key/manifest), length-bounded. */
const DELIVERABLE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
/** A release id is its tag: printable, no `|` (the counters' key separator), no spaces. */
const RELEASE = /^[A-Za-z0-9._+@:/-]{1,128}$/;
/** The release channel alphabet (`CHANNEL` in services/distribution/rollouts.ts). */
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACK_SET = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE = /^[A-Za-z0-9._:-]{1,64}$/;

const isEvent = (v: unknown): v is UpdateEvent =>
  typeof v === "string" && (UPDATE_EVENTS as readonly string[]).includes(v);

/** One entry, or `null` when it is malformed or names an unknown event. */
function boundedEntry(raw: unknown): UpdateEventEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const ok = (v: unknown, re: RegExp): v is string =>
    typeof v === "string" && re.test(v);
  if (
    !ok(e.eventId, EVENT_ID) ||
    !isEvent(e.event) ||
    !ok(e.deliverable, DELIVERABLE) ||
    !ok(e.release, RELEASE) ||
    !ok(e.outlet, OUTLET_ID_PATTERN) ||
    !ok(e.channel, CHANNEL) ||
    typeof e.at !== "number" ||
    !Number.isSafeInteger(e.at) ||
    e.at <= 0
  )
    return null;
  if (e.fromRelease !== undefined && !ok(e.fromRelease, RELEASE)) return null;
  if (e.packSetId !== undefined && !ok(e.packSetId, PACK_SET)) return null;
  if (e.code !== undefined && !ok(e.code, CODE)) return null;
  return {
    eventId: e.eventId,
    event: e.event,
    deliverable: e.deliverable,
    release: e.release,
    ...(e.fromRelease !== undefined ? { fromRelease: e.fromRelease } : {}),
    outlet: e.outlet,
    channel: e.channel,
    ...(e.packSetId !== undefined ? { packSetId: e.packSetId } : {}),
    at: e.at,
    ...(e.code !== undefined ? { code: e.code } : {}),
  };
}

/**
 * Bound `updates`: the first `MAX_UPDATE_EVENTS` entries of an array, each validated strictly;
 * malformed entries and unknown events are dropped, unknown fields stripped. Not an array:
 * `undefined` (the key is dropped).
 */
export function boundedUpdates(input: unknown): UpdateEventEntry[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: UpdateEventEntry[] = [];
  for (const raw of input.slice(0, MAX_UPDATE_EVENTS)) {
    const entry = boundedEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * What a product declares, against which an event's outlet and channel are checked at ingest: its
 * live outlets (Distribution's `delivery` hook) and the channels it can serve (Release's
 * `knownChannels`). An event naming anything else is counted in ONE `unknown` bucket, so a device
 * cannot invent outlets or channels to mint bucket keys or crowd out a real pair. A provider that
 * is off answers an empty set, so everything is `unknown`.
 */
export interface UpdateScope {
  outlets: ReadonlySet<string>;
  channels: ReadonlySet<string>;
}

/** The scope from the product's hooks (Core-mediated: AGENTS.md rule 6). Never throws. */
export async function updateScope(hooks: ServiceHooks): Promise<UpdateScope> {
  const outlets = new Set<string>();
  const channels = new Set<string>();
  try {
    for (const o of (await hooks.delivery()?.outlets()) ?? [])
      outlets.add(o.outletId);
  } catch {
    /* no outlets: everything is unknown */
  }
  try {
    for (const c of (await hooks.releaseCatalog()?.knownChannels()) ?? [])
      channels.add(c);
  } catch {
    /* no channels: everything is unknown */
  }
  return { outlets, channels };
}

/** The object of one (product, deliverable, release). */
function objectName(product: string, deliverable: string, release: string) {
  return `${product}|${deliverable}|${release}`;
}

/**
 * Count one device's validated events: one object call per (deliverable, release) they name.
 * An outlet or channel outside `scope` is counted as (`unknown`, `unknown`).
 * Answers how many were newly counted (a retry counts 0). Never throws.
 */
export async function recordUpdateEvents(
  env: Env,
  product: string,
  deviceId: string,
  entries: readonly UpdateEventEntry[],
  now: number,
  scope: UpdateScope,
): Promise<number> {
  const ns = env.UPDATE_HEALTH;
  if (!ns || entries.length === 0) return 0;
  const groups = new Map<string, HealthEvent[]>();
  for (const e of entries) {
    // Device clocks drift: a future `at` is now, and one past retention is not counted.
    const at = Math.min(e.at, now);
    if (at < now - RETENTION_SECONDS) continue;
    const name = objectName(product, e.deliverable, e.release);
    const list = groups.get(name) ?? [];
    const declared =
      scope.outlets.has(e.outlet) && scope.channels.has(e.channel);
    list.push({
      eventId: e.eventId,
      event: e.event,
      outlet: declared ? e.outlet : UNKNOWN,
      channel: declared ? e.channel : UNKNOWN,
      at,
    });
    groups.set(name, list);
  }
  let counted = 0;
  for (const [name, events] of groups) {
    try {
      const stub = ns.get(ns.idFromName(name));
      const res = await stub.fetch("https://update-health/record", {
        method: "POST",
        body: JSON.stringify({ op: "record", now, deviceId, events }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { counted?: unknown };
      if (typeof body.counted === "number") counted += body.counted;
    } catch {
      /* fail open: the report was stored; a retry of the same events counts them then */
    }
  }
  return counted;
}

export interface UpdateHealthQuery {
  product: string;
  deliverable: string;
  release: string;
  /** The window: the last `windowHours` whole hours up to and including `now`'s hour. */
  windowHours: number;
  now: number;
}

export type { HealthCount };
export { UNKNOWN };

/**
 * One release's counters over a window, per outlet, channel and event, or `null` when they
 * cannot be read (no binding, the object failed). A reader must treat `null` as "no data" —
 * never as zero failures.
 */
export async function readUpdateHealth(
  env: Env,
  q: UpdateHealthQuery,
): Promise<ReadAnswer | null> {
  const ns = env.UPDATE_HEALTH;
  if (!ns) return null;
  const untilHour = hourOf(q.now);
  const sinceHour = untilHour - Math.max(1, Math.floor(q.windowHours)) + 1;
  try {
    const stub = ns.get(
      ns.idFromName(objectName(q.product, q.deliverable, q.release)),
    );
    const res = await stub.fetch("https://update-health/read", {
      method: "POST",
      body: JSON.stringify({ op: "read", sinceHour, untilHour }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<ReadAnswer>;
    if (!Array.isArray(body.counts)) return null;
    return { counts: body.counts, truncated: body.truncated === true };
  } catch {
    return null;
  }
}

/** Sum a read's `devices` (or `events`) for one outlet and channel, per event. */
export function countsFor(
  counts: readonly HealthCount[],
  outlet: string,
  channel: string,
  field: "devices" | "events" = "devices",
): Record<UpdateEvent, number> {
  const out = Object.fromEntries(UPDATE_EVENTS.map((e) => [e, 0])) as Record<
    UpdateEvent,
    number
  >;
  for (const c of counts)
    if (c.outlet === outlet && c.channel === channel && isEvent(c.event))
      out[c.event] += c[field];
  return out;
}
