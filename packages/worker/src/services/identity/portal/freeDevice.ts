/**
 * Freeing one of an account's devices: the operation behind the portal's Remove
 * (`DELETE /api/licenses/<p>/<id>/devices/<deviceId>`) and the sign-in chooser's inline
 * **Replace a device** (plans/I-04.md, "Owner decision (2026-10-05)" §B; I-26 for the legacy
 * product-OIDC page, I-08 for the login card).
 *
 * Both surfaces call this one function so their rules cannot drift apart:
 *
 *   - the product's portal is on (`portal_enabled = 1`);
 *   - the account owns the licence (`getPortalLicense`, the owner pointer);
 *   - the `portalDeviceDisconnect` budget (20 per 60 s, keyed `<product>:<account>:<ip>`) is
 *     charged only AFTER ownership is proven (R5-05), and both surfaces spend the same budget;
 *   - the device belongs to that licence;
 *   - the device is deauthorized and its token record dropped;
 *   - the audit row `portal.device.disconnect` (the chooser adds "to sign in <label>");
 *   - the `deviceRemovedNotice` security email to every verified address.
 *
 * There is no per-licence release cap or cooldown: the Worker has none today. One added later
 * goes here, so both surfaces apply it.
 */

import { deleteTokenRecord } from "../../../platform/kv.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  getDevice,
  getProduct,
  setDeviceStatus,
  type DeviceRow,
} from "../../../core/repo.js";
import {
  clientNetwork,
  rateLimitOk,
  type RateLimit,
} from "../../../core/rateLimit.js";
import {
  getPortalLicense,
  getPortalProductSettings,
  portalAudit,
} from "./repo.js";
import { sendSecurityNotice } from "./email.js";
import { deviceRemovedNotice } from "./notices.js";

/** The rate-limit bucket device removal spends, on every surface. */
export const DEVICE_DISCONNECT_BUCKET = "portalDeviceDisconnect";
/** Removals allowed per window, per (product, account, client IP). */
export const DEVICE_DISCONNECT_LIMIT = 20;
/** The window, in seconds. */
export const DEVICE_DISCONNECT_WINDOW = 60;

/**
 * The counter a portal action charges (R5-05): `product` is both a dimension of the id and the
 * Durable Object shard, so one tenant's traffic can only exhaust that tenant's budget. A caller
 * with no validated product passes `undefined` and keeps the account-wide `_portal` budget.
 */
export function portalActionLimit(
  req: Request,
  accountId: string,
  bucket: string,
  limit: number,
  product: string | undefined,
  windowSec: number,
): { shard: string; rl: RateLimit } {
  return {
    shard: product ?? "_portal",
    rl: {
      bucket,
      id: `${product ?? "_"}:${accountId}:${clientNetwork(req)}`,
      limit,
      windowSec,
    },
  };
}

/** Seconds left in the fixed window `now` falls in (the limiter counts per `floor(now / w)`). */
export function windowRetryAfter(now: number, windowSec: number): number {
  return windowSec - (now % windowSec);
}

export type FreeDeviceResult =
  | { ok: true; device: DeviceRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rate_limited"; retryAfter: number };

/**
 * Free `deviceId` from the account's licence `licenseId` of `product`. `not_found` covers every
 * refusal that must not tell the caller which check failed (portal off, not the account's
 * licence, not that licence's device), exactly as the portal's DELETE answers 404 for each.
 */
export async function freeAccountDevice(
  req: Request,
  env: Env,
  db: Db,
  actor: { accountId: string; email: string | null | undefined },
  product: string,
  licenseId: string,
  deviceId: string,
  now: number,
  opts: {
    /** The installation the freed seat is for (the chooser's Replace): it goes in the audit
     *  summary, "to sign in <label>". */
    forLabel?: string | null;
  } = {},
): Promise<FreeDeviceResult> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return { ok: false, reason: "not_found" };
  const license = await getPortalLicense(
    db,
    actor.accountId,
    product,
    licenseId,
  );
  if (!license) return { ok: false, reason: "not_found" };
  // R5-05: charged AFTER ownership is proven, so a caller who owns no licence on this product
  // cannot spend a budget at all, and the budget they do spend is scoped to this product.
  const { shard, rl } = portalActionLimit(
    req,
    actor.accountId,
    DEVICE_DISCONNECT_BUCKET,
    DEVICE_DISCONNECT_LIMIT,
    product,
    DEVICE_DISCONNECT_WINDOW,
  );
  if (!(await rateLimitOk(env, shard, rl, now))) {
    return {
      ok: false,
      reason: "rate_limited",
      retryAfter: windowRetryAfter(now, DEVICE_DISCONNECT_WINDOW),
    };
  }
  const device = await getDevice(db, product, deviceId);
  if (!device || device.license_id !== licenseId)
    return { ok: false, reason: "not_found" };
  await setDeviceStatus(db, product, deviceId, "deauthorized");
  if (device.token_hash)
    await deleteTokenRecord(env, product, device.token_hash);
  const forLabel = opts.forLabel?.trim();
  await portalAudit(db, {
    accountId: actor.accountId,
    action: "portal.device.disconnect",
    product,
    targetKind: "device",
    targetId: deviceId,
    summary: forLabel
      ? `Disconnected device ${deviceId} to sign in ${forLabel}`
      : `Disconnected device ${deviceId}`,
    now,
  });
  // A security notice (PORTAL.md §6.3): every verified address, the device by its label and
  // the product by its name, never the ids.
  await sendSecurityNotice(
    env,
    db,
    actor.accountId,
    actor.email,
    deviceRemovedNotice({
      deviceLabel: device.label,
      productName: (await getProduct(db, product))?.name,
      productSlug: product,
      origin: new URL(req.url).origin,
    }),
    now,
  );
  return { ok: true, device };
}
