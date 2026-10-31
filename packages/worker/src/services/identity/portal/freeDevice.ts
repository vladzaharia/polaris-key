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
import { type DeviceRow } from "../../../core/repo.js";
import type { DbStatement } from "../../../db/types.js";
import {
  getDevice,
  stmtsDeauthorizeDevice,
} from "../../../core/devices/store.js";
import { getProduct } from "../../../core/products/store.js";
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
import { notifyDeviceChange } from "../../../core/devices/lifecycle.js";
import { existingSubjectFor } from "../../../core/accounts/accountSubjects.js";
import { revokeRemovedDevice } from "../restore/store.js";
import { sendSecurityNotice } from "../../../core/notify/send.js";
import {
  deviceRemovedNotice,
  deviceReplacedNotice,
} from "../../../core/notify/templates.js";

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

/** Spend one removal from the shared budget; the refusal when it is spent, else `null`. */
async function chargeRemoval(
  req: Request,
  env: Env,
  accountId: string,
  product: string,
  now: number,
): Promise<{ ok: false; reason: "rate_limited"; retryAfter: number } | null> {
  const { shard, rl } = portalActionLimit(
    req,
    accountId,
    DEVICE_DISCONNECT_BUCKET,
    DEVICE_DISCONNECT_LIMIT,
    product,
    DEVICE_DISCONNECT_WINDOW,
  );
  if (await rateLimitOk(env, shard, rl, now)) return null;
  return {
    ok: false,
    reason: "rate_limited",
    retryAfter: windowRetryAfter(now, DEVICE_DISCONNECT_WINDOW),
  };
}

export type FreeDeviceResult =
  | { ok: true; device: DeviceRow }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rate_limited"; retryAfter: number };

/** A removal that has passed every check and charged the budget, not yet written. */
export type PlannedFree =
  | {
      ok: true;
      device: DeviceRow;
      /** The removal's writes, for a caller that commits them with something else in one batch. */
      statements: DbStatement[];
      /** Everything that cannot join a batch: the token record, the audit row, the notice. Run once the removal committed. */
      finish(): Promise<void>;
    }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rate_limited"; retryAfter: number };

/**
 * The tail of every device removal, whatever the device is bound to (the licence Remove, the
 * sign-in's Replace and the account's licence-less Remove): run once the deauthorize committed.
 * It drops the token record, deletes the restore keys (a device that signed in by restore takes
 * every restore key of its account for the product with it), tells the other listeners, writes
 * the audit row and sends the security notice to every verified address.
 */
export async function releaseAccountDevice(
  req: Request,
  env: Env,
  db: Db,
  actor: { accountId: string; email: string | null | undefined },
  product: string,
  device: DeviceRow,
  now: number,
  opts: { forLabel?: string | null } = {},
): Promise<void> {
  const deviceId = device.device_id;
  if (device.token_hash)
    await deleteTokenRecord(env, product, device.token_hash);
  // Read the origin mark before the listener drops it: the rule does not depend on the listener.
  await revokeRemovedDevice(db, product, deviceId);
  await notifyDeviceChange(
    { db, env, now },
    { product, deviceId, kind: "removed", subject: device.subject },
  );
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
    // A Replace from the sign-in card says which device took the seat (SIGN-IN.md §3.15).
    forLabel
      ? deviceReplacedNotice({
          deviceLabel: device.label,
          newDeviceLabel: forLabel,
          productName: (await getProduct(db, product))?.name,
          productSlug: product,
          at: now,
          origin: new URL(req.url).origin,
        })
      : deviceRemovedNotice({
          deviceLabel: device.label,
          productName: (await getProduct(db, product))?.name,
          productSlug: product,
          origin: new URL(req.url).origin,
        }),
    now,
  );
}

/**
 * Every check of the removal, with its writes returned instead of run (I-08b, plans/I-04.md
 * §F.3): the sign-in's Replace appends the signing-in device's guarded seat claim and commits both
 * in one D1 batch. `not_found` covers every refusal that must not tell the caller which check
 * failed (portal off, not the account's licence, not that licence's device), exactly as the
 * portal's DELETE answers 404 for each.
 */
export async function planFreeAccountDevice(
  req: Request,
  env: Env,
  db: Db,
  actor: { accountId: string; email: string | null | undefined },
  product: string,
  licenseId: string,
  deviceId: string,
  now: number,
  opts: {
    /** The installation the freed seat is for: it goes in the audit summary, "to sign in <label>". */
    forLabel?: string | null;
  } = {},
): Promise<PlannedFree> {
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
  const limited = await chargeRemoval(req, env, actor.accountId, product, now);
  if (limited) return limited;
  const device = await getDevice(db, product, deviceId);
  if (!device || device.license_id !== licenseId)
    return { ok: false, reason: "not_found" };
  return {
    ok: true,
    device,
    statements: stmtsDeauthorizeDevice(product, deviceId, licenseId),
    finish: () =>
      releaseAccountDevice(req, env, db, actor, product, device, now, opts),
  };
}

/**
 * Free `deviceId` from the account's licence `licenseId` of `product` (the portal's Remove and the
 * legacy chooser's Replace): {@link planFreeAccountDevice}, then its writes, then its tail.
 */
export async function freeAccountDevice(
  ...args: Parameters<typeof planFreeAccountDevice>
): Promise<FreeDeviceResult> {
  const plan = await planFreeAccountDevice(...args);
  if (!plan.ok) return plan;
  await args[2].batch(plan.statements);
  await plan.finish();
  return { ok: true, device: plan.device };
}

/** `devices.license_id` of a device bound to no licence. */
export const NO_LICENSE = "";

/**
 * Remove a device of the account that holds no licence (an app that uses sign-in or Cloud Sync
 * alone, or a device that signed in from backup): `DELETE /api/me/devices/<p>/<deviceId>`.
 * The same budget, audit row and notice as the licence Remove. `not_found` covers every refusal
 * that must not tell the caller which check failed: the portal off, a device of another account
 * or product, an unknown or already removed one, and a device bound to a licence (those are
 * removed through the licence, whose ownership checks this route must not bypass).
 */
export async function freeLicenselessDevice(
  req: Request,
  env: Env,
  db: Db,
  actor: { accountId: string; email: string | null | undefined },
  product: string,
  deviceId: string,
  now: number,
): Promise<FreeDeviceResult> {
  const settings = await getPortalProductSettings(db, product);
  if (settings.portal_enabled !== 1) return { ok: false, reason: "not_found" };
  const subject = await existingSubjectFor(db, actor.accountId, product);
  if (!subject) return { ok: false, reason: "not_found" };
  const device = await getDevice(db, product, deviceId);
  if (
    !device ||
    device.license_id !== NO_LICENSE ||
    device.status !== "authorized" ||
    device.subject !== subject
  )
    return { ok: false, reason: "not_found" };
  // Charged after ownership is proven, like the licence route.
  const limited = await chargeRemoval(req, env, actor.accountId, product, now);
  if (limited) return limited;
  await db.batch(stmtsDeauthorizeDevice(product, deviceId, NO_LICENSE));
  await releaseAccountDevice(req, env, db, actor, product, device, now);
  return { ok: true, device };
}
