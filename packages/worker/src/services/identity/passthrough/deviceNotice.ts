/// <reference types="@cloudflare/workers-types" />

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { getDevice } from "../../../core/devices/store.js";
import { sendSecurityNotice } from "../../../core/notify/send.js";
import { appDeviceApprovedNotice } from "../../../core/notify/templates.js";
import { noticeOrigin } from "../accounts/libraryNotice.js";

/**
 * UK-42.22 (THREAT-MODEL R1-07, app mode): a device-code approval that binds a device to the
 * person's ACCOUNT is the one thing a phished approval buys, so every such bind tells the person.
 * A security notice to every verified address, naming the app and the device, with **Sign out
 * everywhere**. It never fails the bind: the audit row is the record, and `sendSecurityNotice`
 * leaves a count-only row when nobody could be reached.
 */
export async function noticeDeviceCodeBind(
  cx: { req: Request; env: Env; db: Db; product: Product; now: number },
  who: { accountId: string; email: string | null },
  deviceId: string,
  deviceLabel: string | null,
): Promise<void> {
  try {
    // The label the bind stored when this call was not given one (the grant's `complete` is).
    const label =
      deviceLabel ??
      (await getDevice(cx.db, cx.product.slug, deviceId))?.label ??
      null;
    await sendSecurityNotice(
      cx.env,
      cx.db,
      who.accountId,
      who.email,
      appDeviceApprovedNotice({
        deviceLabel: label,
        // TODO(DNI): shownAppName(cx.env, cx.db, cx.product.slug, cx.product.name)
        productName: cx.product.name,
        productSlug: cx.product.slug,
        origin: noticeOrigin(cx.env, cx.req),
        via: "device",
      }),
      cx.now,
    );
  } catch {
    // Swallowed on purpose: the device is bound and audited.
  }
}
