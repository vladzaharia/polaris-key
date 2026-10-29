/**
 * What follows a completed sign-in by silent restore (I-49.7; WIRE-CONTRACT-V5 §12.11.8, "The
 * notice"). The grant (`passthrough/restore.ts` through `bindAndAnswer`) and `choice/complete` (a
 * `confirm` or `choose` the restore grant left open) both send it, so they cannot differ. (The origin mark, `markRestoreOrigin`, is written by
 * each caller right after its bind.)
 *
 *   - the account's primary address gets the `appDeviceApprovedNotice` email with `via: "restore"`
 *     and its "Remove this device" link. It is detection for a shared Apple ID or Google account;
 *     a mail that cannot be sent never fails the sign-in.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { customerOrigin } from "../../../core/hosts.js";
import { appDeviceApprovedNotice } from "../../../core/notify/templates.js";
import { sendNotice } from "../../../core/notify/send.js";
import { resolveSubject } from "../../../core/accounts/accountSubjects.js";
import { getDevice } from "../../../core/devices/store.js";
import { NO_LICENSE_ID } from "../../../core/devices.js";

/**
 * Does the device row already belong to someone else, or to another licence? A restore must not take
 * over such a row (SEC review of I-49.3, note on `bindAndAnswer`). `subject` is the account the
 * restore signs in; a row bound to another subject, after merge aliases, conflicts. `license` is
 * the licence the bind would put the device on: `undefined` skips the licence check, `null` means
 * unknown, and a row that holds any other licence conflicts. A row with no binding never does.
 */
export async function deviceBelongsElsewhere(
  db: Db,
  product: string,
  deviceId: string,
  subject: string,
  license?: string | null,
): Promise<boolean> {
  const row = await getDevice(db, product, deviceId);
  if (!row) return false;
  if (row.subject) {
    const boundTo = await resolveSubject(db, product, row.subject);
    if (boundTo !== null && boundTo !== subject) return true;
  }
  return (
    license !== undefined &&
    row.license_id !== NO_LICENSE_ID &&
    row.license_id !== license
  );
}

/** Send the restore notice. Total: a failure to send is swallowed. */
export async function sendRestoreNotice(
  cx: { req: Request; env: Env; db: Db; product: Product; now: number },
  to: { email: string | null; deviceLabel: string | null },
): Promise<void> {
  const { req, env, db, product, now } = cx;
  try {
    const origin = customerOrigin(env, req) ?? new URL(req.url).origin;
    await sendNotice(
      env,
      db,
      to.email,
      appDeviceApprovedNotice({
        deviceLabel: to.deviceLabel,
        productName: product.name,
        productSlug: product.slug,
        origin,
        via: "restore",
      }),
      now,
    );
  } catch {
    // The sign-in already happened; the shortfall is not the person's to see.
  }
}
