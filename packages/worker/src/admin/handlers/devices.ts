/**
 * License devices (`/api/products/<slug>/licenses/<id>/devices`): list, deauthorize (DELETE
 * or POST), and reset a hardware binding. Deauthorizing also evicts the device's session
 * token from KV and purges its fingerprint + software facts.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { deleteTokenRecord } from "../../kv.js";
import {
  clearFingerprint,
  getDeviceFacts,
  getFingerprint,
  listDevicesByLicense,
  setDeviceStatus,
  getDevice,
} from "../../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound } from "../lib/respond.js";
import { shapeFacts, shapeFingerprint } from "../lib/deviceShape.js";

export async function handleAdminDevices(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  deviceId: string | undefined,
  now: number,
  action?: string,
): Promise<Response> {
  if (!deviceId) {
    if (req.method === "GET") {
      const devices = await listDevicesByLicense(db, slug, licenseId);
      const shaped = await Promise.all(
        devices.map(async (m) => ({
          deviceId: m.device_id,
          status: m.status,
          firstSeen: m.first_seen,
          lastSeen: m.last_seen,
          ua: m.ua ?? undefined,
          label: m.label ?? undefined,
          platform: m.platform ?? undefined,
          arch: m.arch ?? undefined,
          appVersion: m.app_version ?? undefined,
          sdkName: m.sdk_name ?? undefined,
          sdkVersion: m.sdk_version ?? undefined,
          fingerprint: shapeFingerprint(
            await getFingerprint(db, slug, m.device_id),
          ),
          facts: shapeFacts(await getDeviceFacts(db, slug, m.device_id)),
        })),
      );
      return adminJson({ devices: shaped });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const device = await getDevice(db, slug, deviceId);
  if (!device || device.license_id !== licenseId) return notFound();

  // POST .../devices/<id>/fingerprint/reset — the support escape hatch for a false-positive
  // drift lockout. Clearing the binding lets the device's next check-in re-bind cleanly
  // WITHOUT deauthorizing it, so the user keeps working and doesn't burn a seat.
  if (action === "fingerprint") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await clearFingerprint(db, slug, deviceId);
    await audit(
      db,
      slug,
      session,
      now,
      "device.fingerprint.reset",
      { kind: "device", id: deviceId },
      `Cleared the hardware binding for ${deviceId}`,
    );
    return adminJson({ ok: true, deviceId });
  }

  if (req.method === "DELETE" || req.method === "POST") {
    await setDeviceStatus(db, slug, deviceId, "deauthorized");
    if (device.token_hash)
      await deleteTokenRecord(env, slug, device.token_hash);
    await audit(
      db,
      slug,
      session,
      now,
      "device.deauthorize",
      { kind: "device", id: deviceId },
      `Deauthorized ${deviceId}`,
    );
    return adminJson({ ok: true, deviceId });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
