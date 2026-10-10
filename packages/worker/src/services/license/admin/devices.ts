/**
 * License devices (`/manage/api/products/<slug>/license/licenses/<id>/devices`): list,
 * deauthorize (DELETE or POST), and reset a hardware binding. Deauthorizing also evicts the
 * device's session token from KV and purges its fingerprint + software facts.
 */

import { ErrorCode } from "../../../core/errors.js";
import {
  deauthorizeDeviceAsAdmin,
  resetDeviceFingerprintAsAdmin,
} from "../../../core/deviceAdmin.js";
import {
  getDevice,
  getDeviceFacts,
  getFingerprint,
  listDevicesByLicense,
} from "../../../repo.js";
import {
  adminJson,
  notFound as adminNotFound,
  err,
} from "../../../admin/lib/respond.js";
import {
  shapeFacts,
  shapeFingerprint,
} from "../../../admin/lib/deviceShape.js";
import type { LicenseAdminContext } from "./index.js";

export async function handleAdminDevices(
  ctx: LicenseAdminContext,
  licenseId: string,
  deviceId: string | undefined,
  action?: string,
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  const slug = product.slug;
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
          subject: m.subject ?? null,
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
  if (!device || device.license_id !== licenseId) return adminNotFound();

  // POST .../devices/<id>/fingerprint/reset — the support escape hatch for a false-positive
  // drift lockout. Clearing the binding lets the device's next check-in re-bind cleanly
  // WITHOUT deauthorizing it, so the user keeps working and doesn't burn a seat.
  if (action === "fingerprint") {
    if (req.method !== "POST")
      return err(405, ErrorCode.BadRequest, "method not allowed");
    await resetDeviceFingerprintAsAdmin({ env, db, session, now }, device);
    return adminJson({ ok: true, deviceId });
  }

  if (req.method === "DELETE" || req.method === "POST") {
    await deauthorizeDeviceAsAdmin({ env, db, session, now }, device);
    return adminJson({ ok: true, deviceId });
  }
  return err(405, ErrorCode.BadRequest, "method not allowed");
}
