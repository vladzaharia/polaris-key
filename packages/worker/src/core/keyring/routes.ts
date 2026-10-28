/// <reference types="@cloudflare/workers-types" />

/**
 * The Core key ring routes, part I (U-36.2; WIRE-CONTRACT-V5 §13.11.2):
 *
 *   GET    /<p>/devices/keyring                   the subject's ring and the caller's own wrap
 *   POST   /<p>/devices/keyring                   create the ring with the caller's first wrap
 *   PUT    /<p>/devices/keyring/wraps/{deviceId}  store a wrap for a device of the same subject
 *   DELETE /<p>/devices/keyring/wraps/{deviceId}  remove the caller's own wrap
 *
 * Recovery, adopt and reset are U-36.3's. The server stores values it cannot open; this layer
 * checks shapes and who may write, never contents.
 *
 * Order of checks: the route exists (`404` unless a service needs the ring for the product), the
 * method, the device bearer, the subject, the body, then the write. Every route needs a live
 * device token and a signed-in subject; no route reads a subject from the request.
 *
 * Who may write a wrap (T21, R-9). The server cannot see the nearby channel, so it enforces what
 * it can see: a wrap goes only to a LIVE device of the caller's own subject that has registered
 * keys, only for the ring's current epoch and `rootKid`, and a device may deposit a wrap for
 * ANOTHER device only while it holds a current wrap itself (it holds the root). A device may
 * always store a wrap for itself (after a recovery code or a platform backup restored the root).
 * A wrap is create-only, so the slot cannot be overwritten; the owner removes its own and writes
 * again. Clients open a wrap only against the ring's `rootKid`, which the server cannot forge.
 *
 * A wrap is served only to its own device, and only while the wrap row is current: the device is
 * live, still carries the ring's subject, and registered its keys no later than the wrap was made.
 * The lifecycle listener deletes such rows, but it is bookkeeping that can fail, so no route
 * trusts that a row exists.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { bearer } from "../../platform/http.js";
import {
  SYNC_KID_PATTERN,
  SYNC_RING_ID_PATTERN,
} from "@polaris-key/protocol/sync";
import type { DeviceRow } from "../repo.js";
import type { Product } from "../products.js";
import { BodyTooLargeError, readBodyText } from "../cappedBody.js";
import { keyringWanted } from "../contributions.js";
import { launchGateOn } from "../settings/platformRead.js";
import {
  isValidClientDeviceId,
  licenseUsable,
  validateDeviceToken,
} from "../devices.js";
import { getDeviceKeys } from "../devices/keys.js";
import { getDevice } from "../devices/store.js";
import { resolveSyncPrincipal } from "../accounts/accountSubjects.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  notFound,
  wireError,
} from "../errors.js";
import {
  createRing,
  deleteWrap,
  getRing,
  getWrap,
  putWrap,
  type WrapInput,
} from "./store.js";

const RING_ID = new RegExp(SYNC_RING_ID_PATTERN);
const KID = new RegExp(SYNC_KID_PATTERN);
const KEM = /^[A-Za-z0-9._-]{1,32}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A wrap is an `enc` and a `ct` of a few dozen bytes each; the body is far under this. */
const MAX_BODY = 4 * 1024;
const MAX_ENC = 128;
const MAX_WRAP_CT = 512;
const MAX_RECOVERY_CT = 512;

const noContent = (): Response =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const badRequest = (): Response => wireError(400, ErrorCode.BadRequest);
const conflict = (): Response => wireError(409, ErrorCode.KeyringConflict);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const b64url = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && B64URL.test(v);

interface WrapBody {
  kem: string;
  enc: string;
  ct: string;
}

/** The `{kem, enc, ct}` of a wrap, or null when any member is not the expected shape. */
function wrapBody(o: Record<string, unknown>): WrapBody | null {
  const { kem, enc, ct } = o;
  if (typeof kem !== "string" || !KEM.test(kem)) return null;
  if (!b64url(enc, MAX_ENC) || !b64url(ct, MAX_WRAP_CT)) return null;
  return { kem, enc, ct };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readBodyText(req, MAX_BODY)) as unknown;
    return isRecord(v) ? v : null;
  } catch (e) {
    if (e instanceof BodyTooLargeError) throw e;
    return null;
  }
}

/**
 * The device's wrap of the subject's current ring, only while it is current: the device holds
 * keys and registered them no later than the wrap was made (a wrap made for an older key is
 * useless to the device and is never served or counted).
 */
async function currentWrap(
  db: Db,
  product: string,
  subject: string,
  deviceId: string,
) {
  const [wrap, keys] = await Promise.all([
    getWrap(db, product, subject, deviceId),
    getDeviceKeys(db, product, deviceId),
  ]);
  if (!wrap || !keys) return null;
  return wrap.createdAt >= (keys.rotated_at ?? keys.created_at) ? wrap : null;
}

export async function handleKeyring(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  rest: readonly string[],
): Promise<Response> {
  const wrapsTarget =
    rest.length === 2 && rest[0] === "wraps" ? (rest[1] ?? "") : null;
  if (rest.length > 0 && wrapsTarget === null) return notFound();
  // LG-1: with the gate off the routes do not exist, whatever the product has enabled.
  if (!(await launchGateOn(env, db, "launch.syncE2e"))) return notFound();
  if (!(await keyringWanted(db, product))) return notFound();

  const allowed = wrapsTarget === null ? ["GET", "POST"] : ["PUT", "DELETE"];
  if (!allowed.includes(req.method)) return methodNotAllowed();

  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  const unusable =
    "error" in valid ||
    (product.services.license.enabled && !licenseUsable(valid.license, now));
  if (unusable) return wireError(401, ErrorCode.Unauthorized);
  const device = valid.device;
  const principal = await resolveSyncPrincipal(db, device);
  if (!principal || principal.product !== product.slug)
    return wireError(403, ErrorCode.AccountRequired);
  const subject = principal.subject;

  try {
    if (wrapsTarget === null)
      return req.method === "GET"
        ? await getKeyring(db, product, subject, device, now)
        : await postKeyring(req, db, product, subject, device, now);
    if (req.method === "DELETE")
      return await deleteOwnWrap(db, product, subject, device, wrapsTarget);
    return await putTargetWrap(
      req,
      db,
      product,
      subject,
      device,
      wrapsTarget,
      now,
    );
  } catch (e) {
    if (e instanceof BodyTooLargeError) return wireError(413, "body_too_large");
    throw e;
  }
}

async function getKeyring(
  db: Db,
  product: Product,
  subject: string,
  device: DeviceRow,
  now: number,
): Promise<Response> {
  const ring = await getRing(db, product.slug, subject);
  if (!ring) return json({ ring: null, wrap: null });
  const wrap = await currentWrap(db, product.slug, subject, device.device_id);
  return json({
    ring: {
      ringId: ring.ringId,
      epoch: ring.epoch,
      rootKid: ring.rootKid,
      state: ring.state,
      createdAt: ring.createdAt,
      recovery: { set: ring.recoverySet, createdAt: ring.recoveryAt },
      adopted: ring.adopted.map((a) => ({
        ringId: a.ringId,
        epoch: a.epoch,
        kid: a.kid,
        ct: a.ct,
      })),
      ...(ring.previous && ring.previous.until > now
        ? { previous: ring.previous }
        : {}),
    },
    wrap: wrap && {
      epoch: wrap.epoch,
      kid: wrap.kid,
      kem: wrap.kem,
      enc: wrap.enc,
      ct: wrap.ct,
      by: wrap.by,
    },
  });
}

async function postKeyring(
  req: Request,
  db: Db,
  product: Product,
  subject: string,
  device: DeviceRow,
  now: number,
): Promise<Response> {
  const o = await readJson(req);
  if (!o) return badRequest();
  const { ringId, rootKid } = o;
  if (typeof ringId !== "string" || !RING_ID.test(ringId)) return badRequest();
  if (typeof rootKid !== "string" || !KID.test(rootKid)) return badRequest();
  const wrap = isRecord(o.wrap) ? wrapBody(o.wrap) : null;
  if (!wrap) return badRequest();
  let recoveryCt: string | null = null;
  if (o.recovery !== undefined) {
    if (!isRecord(o.recovery) || !b64url(o.recovery.ct, MAX_RECOVERY_CT))
      return badRequest();
    recoveryCt = o.recovery.ct;
  }
  // The creator's own wrap is useless, and never served, without keys it can unwrap with.
  if (!(await getDeviceKeys(db, product.slug, device.device_id)))
    return badRequest();

  const r = await createRing(db, {
    product: product.slug,
    subject,
    ringId,
    rootKid,
    wrap: {
      ...wrap,
      deviceId: device.device_id,
      ringId,
      epoch: 1,
      kid: rootKid,
      by: device.device_id,
    },
    recoveryCt,
    now,
  });
  return r === "conflict"
    ? conflict()
    : json({ ringId, epoch: 1 }, { status: 201 });
}

async function putTargetWrap(
  req: Request,
  db: Db,
  product: Product,
  subject: string,
  device: DeviceRow,
  targetId: string,
  now: number,
): Promise<Response> {
  if (!isValidClientDeviceId(targetId)) return notFound();
  const o = await readJson(req);
  if (!o) return badRequest();
  const { epoch, kid } = o;
  const wrap = wrapBody(o);
  if (
    !wrap ||
    typeof epoch !== "number" ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    typeof kid !== "string" ||
    !KID.test(kid)
  )
    return badRequest();

  // The target is a live device that still carries this subject and holds keys to open a wrap.
  // Anything else is one answer, so the route does not say which devices exist.
  const target =
    targetId === device.device_id
      ? device
      : await getDevice(db, product.slug, targetId);
  const targetPrincipal = target && (await resolveSyncPrincipal(db, target));
  if (
    !target ||
    !targetPrincipal ||
    targetPrincipal.product !== product.slug ||
    targetPrincipal.subject !== subject ||
    !(await getDeviceKeys(db, product.slug, targetId))
  )
    return notFound();

  // Only a device that holds the root deposits a wrap for another device.
  if (
    targetId !== device.device_id &&
    !(await currentWrap(db, product.slug, subject, device.device_id))
  )
    return wireError(403, ErrorCode.Forbidden);

  const ring = await getRing(db, product.slug, subject);
  if (!ring || ring.epoch !== epoch || ring.rootKid !== kid) return conflict();

  const input: WrapInput = {
    ...wrap,
    deviceId: targetId,
    ringId: ring.ringId,
    epoch,
    kid,
    by: device.device_id,
  };
  const r = await putWrap(db, product.slug, subject, input, now);
  return r === "created" ? noContent() : conflict();
}

async function deleteOwnWrap(
  db: Db,
  product: Product,
  subject: string,
  device: DeviceRow,
  targetId: string,
): Promise<Response> {
  if (targetId !== device.device_id) return wireError(403, ErrorCode.Forbidden);
  await deleteWrap(db, product.slug, subject, device.device_id);
  return noContent();
}
