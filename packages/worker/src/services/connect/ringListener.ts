/**
 * Cloud Connect's device-lifecycle listener (CC-06.3; plans/CC-01-cloud-connect.md §1;
 * `core/devices/lifecycle.ts`). It is the primary path that moves a person's roster: when a device
 * is removed, unbound, bound to a subject, or registers new keys, the rings it touches are brought
 * up to date at once, with the same hash-guarded bump as a read (`currentRing`) and the same leave
 * rule (no previous discovery key after a leave). The read-time check stays as a backstop.
 *
 * Which rings: the subject the event names, the subject the device row carries now, and every ring
 * that lists the device among its members (a device that was bound elsewhere before is found
 * there). Only rings that already exist are moved; the first read creates one. A product with
 * Cloud Connect off is left alone: the read-time check catches up when it is switched on.
 *
 * A listener is bookkeeping: it cannot refuse the write, and a failure for one subject does not
 * stop the others.
 */

import { accountDeviceKeys } from "../../core/devices/keys.js";
import {
  deviceSubjectOf,
  type DeviceChange,
  type DeviceChangeListener,
} from "../../core/devices/lifecycle.js";
import { getProduct } from "../../core/products/store.js";
import { parseServices } from "../../core/services.js";
import type { Db } from "../../db/types.js";
import { pokeRelay } from "./relayPoke.js";
import {
  currentRing,
  getRing,
  RingTooLargeError,
  type BumpReason,
} from "./ring.js";

export const CONNECT_RING_LISTENER = "connect.ring";

/** Move one subject's existing ring to its members now. Returns whether the epoch moved. */
export async function bumpRingNow(
  db: Db,
  product: string,
  subject: string,
  now: number,
  reason: BumpReason,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const row = await getProduct(db, product);
  if (!row) return false;
  const { services } = parseServices(row.services_json);
  if (!services.connect.enabled) return false;
  if (!(await getRing(db, product, subject))) return false;
  const seatsHeld = services.license.enabled;
  try {
    const { row: ring, bumped } = await currentRing(
      db,
      product,
      subject,
      () => accountDeviceKeys(db, product, subject, { seatsHeld, now }),
      now,
      { reason, force: opts.force },
    );
    if (bumped) await pokeRelay({ product, subject, epoch: ring.epoch });
    return bumped;
  } catch (e) {
    // A roster over its size is refused at the next read; nothing moves here.
    if (e instanceof RingTooLargeError) return false;
    throw e;
  }
}

/** The subjects whose ring lists the device (an exact match on a line of `member_ids`). */
async function subjectsListing(
  db: Db,
  product: string,
  deviceId: string,
): Promise<string[]> {
  const rows = await db.all<{ subject: string }>(
    `SELECT subject FROM connect_rings
      WHERE product = ?
        AND instr(char(10) || member_ids || char(10), char(10) || ? || char(10)) > 0`,
    product,
    deviceId,
  );
  return rows.map((r) => r.subject);
}

export const connectRingListener: DeviceChangeListener = async (
  { db, now },
  event: DeviceChange,
) => {
  const subjects = new Set<string>(
    await subjectsListing(db, event.product, event.deviceId),
  );
  if (event.subject) subjects.add(event.subject);
  const current = await deviceSubjectOf(db, event.product, event.deviceId);
  if (current) subjects.add(current);
  for (const subject of subjects) {
    try {
      await bumpRingNow(db, event.product, subject, now, event.kind);
    } catch {
      // One subject's failure is not another's; the read-time check is the backstop.
    }
  }
};
