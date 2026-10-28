/**
 * `GET /manage/api/products/<slug>/connect/people?cursor=` (CC-16.W): the people who have linked
 * a device, paged by pairwise subject, each with their devices and the roster epoch.
 *
 *   { enabled: true,
 *     people: [{ subject, label, ringEpoch,
 *                devices: [{ deviceId, label, platform, keysSince, certExpiresAt, lastRelayAt, lastSeen }] }],
 *     nextCursor: string | null }
 *
 * A person is a row of `connect_rings` (created when a device first reads its identity); the
 * devices are Core's roster rule (`accountDeviceListing`). `label` (a person's name) has no stored
 * source on the Worker, and `certExpiresAt` / `lastRelayAt` are not stored either (a certificate is
 * signed per read, the relay meters per product and day), so all three are `null`. No key,
 * certificate, email or hardware value is read or returned. A product with Connect off answers
 * `{ enabled: false }`.
 */

import { adminJson } from "../../../core/console/respond.js";
import { accountDeviceListing } from "../../../core/devices/keys.js";
import { knownPlatform } from "../../../core/devices/platformFamily.js";
import type { ConnectAdminContext } from "./index.js";

export const PEOPLE_PAGE = 50;

export async function handlePeople(
  ctx: ConnectAdminContext,
): Promise<Response> {
  const { db, product, now, req } = ctx;
  if (!product.services.connect.enabled) return adminJson({ enabled: false });
  const cursor = new URL(req.url).searchParams.get("cursor") ?? "";
  const rows = await db.all<{ subject: string; epoch: number }>(
    `SELECT subject, epoch FROM connect_rings
      WHERE product = ? AND subject > ? ORDER BY subject LIMIT ?`,
    product.slug,
    cursor,
    PEOPLE_PAGE + 1,
  );
  const page = rows.slice(0, PEOPLE_PAGE);
  const seatsHeld = product.services.license.enabled;
  const people = [];
  for (const r of page) {
    const devices = await accountDeviceListing(db, product.slug, r.subject, {
      seatsHeld,
      now,
    });
    people.push({
      subject: r.subject,
      label: null,
      ringEpoch: r.epoch,
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        platform: knownPlatform(d.platform),
        keysSince: d.keysSince,
        certExpiresAt: null,
        lastRelayAt: null,
        lastSeen: d.lastSeen,
      })),
    });
  }
  return adminJson({
    enabled: true,
    people,
    nextCursor:
      rows.length > PEOPLE_PAGE ? page[page.length - 1]!.subject : null,
  });
}
