/**
 * One device lifecycle (R-7): who hears that a device's binding or keys changed.
 *
 * Core writes the device rows (`core/devices.ts`, `core/devices/store.ts`, the keys route, a
 * licence deletion). A service that keeps state per device contributes a listener on its descriptor
 * (`contributes.onDeviceChange`, `core/contributions.ts`), so Core never imports a service and the
 * service never reads Core's device rows (rule 6). The events:
 *
 *   bound    the device now carries an account subject (a sign-in);
 *   unbound  the subject was cleared (a sign-out, an account removal);
 *   removed  the device is gone from the licence: deauthorized, or deleted with its licence;
 *   keys     the device registered or rotated its public keys.
 *
 * Like `onAuthorization` a listener is BOOKKEEPING: it runs only after the write succeeded, it
 * cannot refuse or change anything, and one that throws is ignored. Unlike it, a listener runs for
 * every mounted service whatever the product's enablement, because a removal must reach a service
 * that was switched off since it stored something; a listener reads the enablement itself.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { contributedDeviceChangeListeners } from "../contributions.js";
import { runListeners } from "../authorizationListeners.js";
import type { WaitUntil } from "../licensing/refusals.js";

export type DeviceChangeKind = "bound" | "unbound" | "removed" | "keys";

export interface DeviceChange {
  product: string;
  deviceId: string;
  kind: DeviceChangeKind;
  /** The pairwise subject involved, when the write knows it (new for `bound`, previous otherwise). */
  subject?: string | null;
  /** The device's key sequence after a `keys` change. */
  keySeq?: number;
}

export interface DeviceChangeContext {
  db: Db;
  /** Absent for the writes that hold no environment (the subject write). */
  env?: Env;
  now: number;
}

export type DeviceChangeListener = (
  ctx: DeviceChangeContext,
  event: DeviceChange,
) => Promise<void>;

/** Is anyone listening? Callers skip the reads that only feed an event when nobody is. */
export function hasDeviceChangeListeners(): boolean {
  return contributedDeviceChangeListeners().length > 0;
}

/**
 * Tell every listener about one change. Total: a listener that throws or rejects is ignored and the
 * others still run. With `waitUntil` the work is handed to the runtime and this returns at once.
 */
export async function notifyDeviceChange(
  ctx: DeviceChangeContext,
  event: DeviceChange,
  waitUntil?: WaitUntil,
): Promise<void> {
  await runListeners(
    contributedDeviceChangeListeners(),
    (l) => l(ctx, event),
    waitUntil,
  );
}

/** The subject a device row carries now, for an event that names it. Null when none or no row. */
export async function deviceSubjectOf(
  db: Db,
  product: string,
  deviceId: string,
): Promise<string | null> {
  const row = await db.first<{ subject: string | null }>(
    "SELECT subject FROM devices WHERE product = ? AND device_id = ?",
    product,
    deviceId,
  );
  return row?.subject ?? null;
}
