/**
 * The admin effects on ONE device, shared by every admin surface that can act on it.
 *
 * Two routes deauthorize a device: License's `licenses/<id>/devices/<id>` (a device seen through
 * the license it holds a seat on) and Core's product-wide `devices/<id>` (a device seen through
 * the product, which is the only way to reach one that holds no license at all). They must have
 * the SAME effect and write the SAME audit row, so the effect lives here once and both call it.
 * Core may not import a service, hence the helper sits under `core/` and License imports it.
 *
 * Neither function checks that the device belongs to a particular license: that is the calling
 * route's business (the license route refuses a device of another license; the product route has
 * no such scope). They take a device row the caller has already loaded and scoped.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { DeviceRow } from "../repo.js";
import { audit } from "../admin/audit.js";
import type { AdminSession } from "../admin/session.js";
import { clearFingerprint } from "../repo.js";
import { retireDeviceBinding } from "./devices.js";

interface DeviceAdminCtx {
  env: Env;
  db: Db;
  session: AdminSession;
  now: number;
}

/**
 * Deauthorize a device: mark it deauthorized (which releases its seat and purges its fingerprint
 * and software facts) and evict its KV token record so the credential stops working now rather
 * than at expiry. A license-free device holds no seat, so nothing is released for it; under open
 * registration it can simply register again.
 */
export async function deauthorizeDeviceAsAdmin(
  ctx: DeviceAdminCtx,
  device: DeviceRow,
): Promise<void> {
  const { env, db, session, now } = ctx;
  await retireDeviceBinding(
    env,
    db,
    device.product,
    device.device_id,
    device.token_hash,
  );
  await audit(
    db,
    device.product,
    session,
    now,
    "device.deauthorize",
    { kind: "device", id: device.device_id },
    `Deauthorized ${device.device_id}`,
  );
}

/**
 * Clear a device's hardware binding WITHOUT deauthorizing it: the support escape hatch for a
 * false-positive drift lockout. The next check-in re-binds cleanly and no seat is burned.
 */
export async function resetDeviceFingerprintAsAdmin(
  ctx: DeviceAdminCtx,
  device: DeviceRow,
): Promise<void> {
  const { db, session, now } = ctx;
  await clearFingerprint(db, device.product, device.device_id);
  await audit(
    db,
    device.product,
    session,
    now,
    "device.fingerprint.reset",
    { kind: "device", id: device.device_id },
    `Cleared the hardware binding for ${device.device_id}`,
  );
}
