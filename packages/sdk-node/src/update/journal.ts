// The update-health journal (SDK parity pass §3.13, P6-03): the update outcome events this device
// has not yet reported, persisted in the state directory so a restart between "downloaded" and
// the next report loses nothing.
//
// Each event is one entry of `POST /<p>/devices/report`'s `updates` key, in the shape the
// Worker's `boundedUpdates` accepts (packages/worker/src/core/updateHealth.ts):
//
//     {eventId, event, deliverable, release, fromRelease?, outlet, channel, packSetId?, at, code?}
//
// At most `MAX_UPDATE_EVENTS_PER_REPORT` go in one report, oldest first; the rest wait for the
// next. A report the server accepted marks the events it carried as sent (they are dropped). The
// Worker deduplicates on (device, eventId), so an event resent after a lost answer counts once.
// The journal keeps at most `MAX_JOURNAL` unsent events, dropping the oldest, so a device that
// never reaches the server cannot grow the file without bound.

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  UPDATE_EVENT_VALUES,
  type UpdateEvent,
} from "../constants.generated.js";
import { readJson, writeJson } from "../core/jsonFile.js";

/** At most this many events per report (the Worker's `MAX_UPDATE_EVENTS`). */
export const MAX_UPDATE_EVENTS_PER_REPORT = 16;
/** At most this many unsent events are kept. */
export const MAX_JOURNAL = 256;

/** One `updates` entry. */
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

/** What a caller says about one event; the journal fills in the id, outlet, channel and time. */
export interface UpdateEventInput {
  /** The release the event is about: its tag when known, else its version. */
  release: string;
  /** The release the device moved from, when it differs. */
  fromRelease?: string | null;
  /** Default `"app"`; a pack event names the pack's deliverable. */
  deliverable?: string;
  /** Default: the client's channel. */
  channel?: string;
  packSetId?: string | null;
  /** A short error code for `pack_failed`, `update_reverted`, `boot_rolled_back`. */
  code?: string | null;
}

const CODE = /^[A-Za-z0-9._:-]{1,64}$/;
const DELIVERABLE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const RELEASE = /^[A-Za-z0-9._+@:/-]{1,128}$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface JournalContext {
  stateDir: string;
  /** The outlet id events are reported under (`unknown` when the client has none). */
  outlet: () => string;
  /** The client's channel. */
  channel: () => string;
  now?: () => number;
}

export class UpdateJournal {
  private readonly file: string;
  /** Serialises the read-modify-write cycles. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly w: JournalContext) {
    this.file = join(w.stateDir, "update-events.json");
  }

  /** Record one event. Malformed values are dropped (the event is not recorded) rather than
   *  sent for the Worker to discard; returns the entry, or null when it was refused. */
  record(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): Promise<UpdateEventEntry | null> {
    const entry = this.entry(event, input);
    if (!entry) return Promise.resolve(null);
    return this.serial(async () => {
      const all = await this.all();
      all.push(entry);
      await writeJson(this.file, all.slice(-MAX_JOURNAL));
      return entry;
    });
  }

  /** The events the next report carries: the oldest `MAX_UPDATE_EVENTS_PER_REPORT`. */
  async pending(): Promise<UpdateEventEntry[]> {
    return (await this.all()).slice(0, MAX_UPDATE_EVENTS_PER_REPORT);
  }

  /** Every unsent event, oldest first. */
  async all(): Promise<UpdateEventEntry[]> {
    const raw = await readJson<unknown>(this.file, []);
    return Array.isArray(raw)
      ? (raw.filter(
          (e) =>
            e &&
            typeof e === "object" &&
            UPDATE_EVENT_VALUES.includes((e as UpdateEventEntry).event),
        ) as UpdateEventEntry[])
      : [];
  }

  /** Drop the events a report delivered. */
  markSent(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return Promise.resolve();
    const sent = new Set(eventIds);
    return this.serial(async () => {
      const keep = (await this.all()).filter((e) => !sent.has(e.eventId));
      await writeJson(this.file, keep);
    });
  }

  private entry(
    event: UpdateEvent,
    input: UpdateEventInput,
  ): UpdateEventEntry | null {
    if (!UPDATE_EVENT_VALUES.includes(event)) return null;
    const deliverable = input.deliverable ?? "app";
    const channel = input.channel ?? this.w.channel();
    if (!RELEASE.test(input.release) || !DELIVERABLE.test(deliverable))
      return null;
    const out: UpdateEventEntry = {
      eventId: `${randomBytes(8).toString("hex")}-${event}`,
      event,
      deliverable,
      release: input.release,
      outlet: this.w.outlet() || "unknown",
      channel: CHANNEL.test(channel) ? channel : "stable",
      at: (this.w.now ?? (() => Math.floor(Date.now() / 1000)))(),
    };
    if (
      input.fromRelease &&
      input.fromRelease !== input.release &&
      RELEASE.test(input.fromRelease)
    )
      out.fromRelease = input.fromRelease;
    if (input.packSetId) out.packSetId = input.packSetId;
    if (input.code && CODE.test(input.code)) out.code = input.code;
    return out;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
