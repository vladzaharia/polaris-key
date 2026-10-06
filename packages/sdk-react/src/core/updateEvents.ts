// Update-health events (SDK parity pass §3.13, P6-03): the update outcome events a device
// reports on `POST /<p>/devices/report`'s `updates` key, in the shape the Worker's
// `boundedUpdates` accepts (packages/worker/src/core/updateHealth.ts):
//
//     {eventId, event, deliverable, release, fromRelease?, outlet, channel, packSetId?, at, code?}
//
// `buildUpdateEvent` is the one place a React adapter turns what a caller says about an event
// into that entry, with the same defaults and the same validation as Node's `UpdateJournal`
// (packages/sdk-node/src/update/journal.ts): a malformed value means the event is not recorded,
// rather than sent for the Worker to discard.

import {
  UPDATE_EVENT_VALUES,
  type UpdateEvent,
} from "../constants.generated.js";

/** One `updates` entry, the Worker's `UpdateEventEntry`. */
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

/** What a caller says about one event; the adapter fills in the id, outlet, channel and time.
 *  Node's `UpdateEventInput`, field for field. */
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

/** What the adapter knows that the caller does not. */
export interface UpdateEventContext {
  /** The outlet id events are reported under (`unknown` when there is none). */
  outlet: string | null;
  /** The client's channel. */
  channel: string;
  /** Epoch seconds. */
  now: number;
  /** A fresh event id (the Worker counts each `(device, eventId)` once). */
  eventId: string;
}

const CODE = /^[A-Za-z0-9._:-]{1,64}$/;
const DELIVERABLE = /^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const RELEASE = /^[A-Za-z0-9._+@:/-]{1,128}$/;
const CHANNEL = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True for one of the P6-03 event names. */
export function isUpdateEvent(v: unknown): v is UpdateEvent {
  return (UPDATE_EVENT_VALUES as readonly unknown[]).includes(v);
}

/** The entry for one event, or null when a value is malformed (the event is not recorded). */
export function buildUpdateEvent(
  event: UpdateEvent,
  input: UpdateEventInput,
  ctx: UpdateEventContext,
): UpdateEventEntry | null {
  if (!isUpdateEvent(event) || !input || typeof input.release !== "string")
    return null;
  const deliverable = input.deliverable ?? "app";
  const channel = input.channel ?? ctx.channel;
  if (!RELEASE.test(input.release) || !DELIVERABLE.test(deliverable))
    return null;
  const out: UpdateEventEntry = {
    eventId: ctx.eventId,
    event,
    deliverable,
    release: input.release,
    outlet: ctx.outlet || "unknown",
    channel: CHANNEL.test(channel) ? channel : "stable",
    at: ctx.now,
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
