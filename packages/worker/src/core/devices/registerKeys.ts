/**
 * The one Core operation that registers or rotates a device's keys and tells the listeners
 * (V5 §15.8). The keys route, the exchange and `choice/complete` all go through it, so a rotation
 * always drops the device's key-ring wraps and bumps a Connect roster, and a first registration
 * after `bound` still reaches both.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import {
  upsertDeviceKeys,
  type DeviceKeyPair,
  type UpsertResult,
} from "./keys.js";
import { notifyDeviceChange } from "./lifecycle.js";

export async function registerDeviceKeys(
  ctx: { db: Db; env: Env; now: number },
  product: string,
  deviceId: string,
  keys: DeviceKeyPair,
  popAt?: number,
  heldSignKey?: string | null,
  /**
   * How the keys came to be registered, for a listener that cares: `restore` is a sign-in by a
   * silent-restore key (I-49.7, V5 §12.11.8). It changes nothing about the write.
   */
  via?: "restore",
): Promise<UpsertResult> {
  const r = await upsertDeviceKeys(
    ctx.db,
    product,
    deviceId,
    keys,
    ctx.now,
    popAt,
    heldSignKey,
  );
  if (r.changed)
    await notifyDeviceChange(ctx, {
      product,
      deviceId,
      kind: "keys",
      keySeq: r.keySeq,
      ...(via ? { via } : {}),
    });
  return r;
}
