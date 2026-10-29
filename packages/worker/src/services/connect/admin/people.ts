/**
 * `GET /manage/api/products/<slug>/connect/people?cursor=&subject=` (CC-16.W): the people who have
 * linked a device, paged by pairwise subject, each with their devices and the roster epoch.
 * `subject` is an exact filter: that one person, or an empty page when they have no ring.
 *
 *   { enabled: true,
 *     people: [{ subject, label, ringEpoch,
 *                devices: [{ deviceId, label, platform, keysSince, lastSeen }] }],
 *     nextCursor: string | null }
 *
 * A person is a row of `connect_rings` (created when a device first reads its identity); the
 * devices are Core's roster rule (`accountDeviceListing`). A person's `label` is their shared contact
 * email (Core's `contactEmailsFor`, the rule Users uses: the buyer's licence email, else the
 * account email only with the person's consent while Identity is on), `null` without one.
 * A certificate is signed per read and the relay meters per product and day, so neither a
 * certificate expiry nor a last relay use exists to return (CC-16.4, D-15). No key, certificate or
 * hardware value is read or returned. A product with Connect off answers `{ enabled: false }`.
 */

import { contactEmailsFor } from "../../../core/accounts/contactEmail.js";
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
  const params = new URL(req.url).searchParams;
  const cursor = params.get("cursor") ?? "";
  const subject = params.get("subject");
  const rows = subject
    ? await db.all<{ subject: string; epoch: number }>(
        `SELECT subject, epoch FROM connect_rings WHERE product = ? AND subject = ?`,
        product.slug,
        subject,
      )
    : await db.all<{ subject: string; epoch: number }>(
        `SELECT subject, epoch FROM connect_rings
          WHERE product = ? AND subject > ? ORDER BY subject LIMIT ?`,
        product.slug,
        cursor,
        PEOPLE_PAGE + 1,
      );
  const page = rows.slice(0, PEOPLE_PAGE);
  const seatsHeld = product.services.license.enabled;
  const emails = await contactEmailsFor(
    db,
    product.slug,
    page.map((r) => r.subject),
    { identityOn: product.services.identity.enabled },
  );
  const people = [];
  for (const r of page) {
    const devices = await accountDeviceListing(db, product.slug, r.subject, {
      seatsHeld,
      now,
    });
    people.push({
      subject: r.subject,
      label: emails.get(r.subject) ?? null,
      ringEpoch: r.epoch,
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        platform: knownPlatform(d.platform),
        keysSince: d.keysSince,
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
