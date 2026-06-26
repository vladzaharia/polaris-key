/**
 * License devices (`/api/products/<slug>/licenses/<id>/devices`): list, and deauthorize
 * (DELETE or POST). Deauthorizing also evicts the device's session token from KV.
 */

import type { Env } from "../../env.js";
import type { Db } from "../../db/types.js";
import { ErrorCode } from "../../http.js";
import { deleteTokenRecord } from "../../kv.js";
import {
  listDevicesByLicense,
  setDeviceStatus,
  getDevice,
} from "../../repo.js";
import { audit } from "../audit.js";
import type { AdminSession } from "../session.js";
import { adminJson, err, notFound } from "../lib/respond.js";

export async function handleAdminDevices(
  req: Request,
  env: Env,
  db: Db,
  session: AdminSession,
  slug: string,
  licenseId: string,
  deviceId: string | undefined,
  now: number,
): Promise<Response> {
  if (!deviceId) {
    if (req.method === "GET") {
      const devices = await listDevicesByLicense(db, slug, licenseId);
      return adminJson({
        devices: devices.map((m) => ({
          deviceId: m.device_id,
          status: m.status,
          firstSeen: m.first_seen,
          lastSeen: m.last_seen,
          ua: m.ua ?? undefined,
          label: m.label ?? undefined,
        })),
      });
    }
    return err(405, ErrorCode.BadRequest, "method not allowed");
  }
  const device = await getDevice(db, slug, deviceId);
  if (!device || device.license_id !== licenseId) return notFound();
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
