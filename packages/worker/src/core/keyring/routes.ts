/// <reference types="@cloudflare/workers-types" />

/**
 * The Core key ring routes (U-36.2 and U-36.3; WIRE-CONTRACT-V5 §13.11.2):
 *
 *   GET    /<p>/devices/keyring                   the subject's ring and the caller's own wrap
 *   POST   /<p>/devices/keyring                   create the ring with the caller's first wrap
 *   PUT    /<p>/devices/keyring/wraps/{deviceId}  store a wrap for a device of the same subject
 *   DELETE /<p>/devices/keyring/wraps/{deviceId}  remove the caller's own wrap
 *   PUT    /<p>/devices/keyring/recovery          replace the sealed recovery blob (audited, emailed)
 *   GET    /<p>/devices/keyring/recovery          fetch it (5 a day per device and per subject, audited, emailed)
 *   POST   /<p>/devices/keyring/adopt             store a root sealed under the current one
 *   POST   /<p>/devices/keyring/reset             a new ring; the old one is `previous` for 30 days
 *
 * The server stores values it cannot open; this layer checks shapes and who may write, never
 * contents. The recovery and adopt blobs are the one exception to "shapes only": the contract fixes
 * their layout (version byte and length), so those two are checked to it.
 *
 * Recovery (T23). The fetch is for a device that holds NO root, so it needs only a live device
 * token and a signed-in subject. The blob is sealed under a 128-bit code the server never sees; the
 * brake on a stolen device token is the rate limit, the audit row and the email to the account.
 * Writing a blob, adopting and sealing need the root, so those need a current wrap. A reset
 * does not: "start over" is for a person who has lost every root (T22).
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
 * again. Clients open a wrap only against the ring's `rootKid`, and only for the ring they pinned
 * when they first acquired a root: a served ring that differs is reported to the person, never
 * adopted by the client on its own.
 *
 * A wrap is served only to its own device, and only while the wrap row is current: the device is
 * live, still carries the ring's subject, and registered its keys no later than the wrap was made.
 * The lifecycle listener deletes such rows, but it is bookkeeping that can fail, so no route
 * trusts that a row exists.
 */

import { isJsonObject } from "../../platform/json.js";
import { b64urlDecodeStrict } from "../../platform/bytes.js";
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
import {
  accountForSubject,
  resolveSyncPrincipal,
} from "../accounts/accountSubjects.js";
import { appendAudit } from "../audit.js";
import { randomId } from "../../platform/crypto.js";
import { rateLimitOk } from "../rateLimit.js";
import { sendSecurityNotice } from "../notify/send.js";
import {
  encryptionResetNotice,
  recoveryCodeChangedNotice,
  recoveryStartedNotice,
  type NoticeMessage,
} from "../notify/templates.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  notFound,
  wireError,
} from "../errors.js";
import {
  addAdopted,
  createRing,
  deleteWrap,
  getRecovery,
  getRing,
  getWrap,
  putWrap,
  resetRing,
  setRecovery,
  type WrapInput,
} from "./store.js";

const RING_ID = new RegExp(SYNC_RING_ID_PATTERN);
const KID = new RegExp(SYNC_KID_PATTERN);
/** §13.11.1: the wrap's `kem` is the JSON integer 32 (X25519), nothing else. */
const KEM_X25519 = 32;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A wrap is an `enc` and a `ct` of a few dozen bytes each; the body is far under this. */
const MAX_BODY = 4 * 1024;
const MAX_ENC = 128;
const MAX_WRAP_CT = 512;
const MAX_RECOVERY_CT = 512;

/** A device's recovery fetches per day (T23): each one is audited and emailed. */
export const RECOVERY_FETCH_LIMIT = {
  bucket: "keyringRecovery",
  limit: 5,
  windowSec: 86_400,
} as const;

/**
 * The same budget per subject, so a rotation of device ids does not reset it. Fails closed. It
 * counts only fetches that return a blob (T23): a probe that finds nothing is checked, not
 * counted, so it cannot spend the owner's quota.
 */
export const RECOVERY_FETCH_SUBJECT_LIMIT = {
  bucket: "keyringRecoverySubject",
  limit: 5,
  windowSec: 86_400,
} as const;

/** `recoveryWrap` and the adopt blob (§13.11.4): `0x01 ‖ n12 ‖ AES-256-GCM(.., R)` is 61 bytes. */
const SEALED_BLOB_BYTES = 61;
const SEALED_BLOB_VERSION = 1;

const noContent = (): Response =>
  new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
const badRequest = (): Response => wireError(400, ErrorCode.BadRequest);
const conflict = (): Response => wireError(409, ErrorCode.KeyringConflict);

const isB64urlField = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max && B64URL.test(v);

/**
 * A sealed recovery or adopt blob in its contract layout: base64url without padding, in its one
 * canonical spelling, of exactly 61 bytes whose first byte is the version.
 */
function sealedBlob(v: unknown): v is string {
  if (!isB64urlField(v, 96)) return false;
  const bytes = b64urlDecodeStrict(v);
  return (
    bytes !== null &&
    bytes.length === SEALED_BLOB_BYTES &&
    bytes[0] === SEALED_BLOB_VERSION
  );
}

/** An epoch (an integer of at least 1) and a root `kid`. */
function epochKid(
  epoch: unknown,
  kid: unknown,
): { epoch: number; kid: string } | null {
  return typeof epoch === "number" &&
    Number.isSafeInteger(epoch) &&
    epoch >= 1 &&
    typeof kid === "string" &&
    KID.test(kid)
    ? { epoch, kid }
    : null;
}

interface WrapBody {
  kem: number;
  enc: string;
  ct: string;
}

/** The `{kem, enc, ct}` of a wrap, or null when any member is not the expected shape. */
function wrapBody(o: Record<string, unknown>): WrapBody | null {
  const { kem, enc, ct } = o;
  if (kem !== KEM_X25519) return null;
  if (!isB64urlField(enc, MAX_ENC) || !isB64urlField(ct, MAX_WRAP_CT))
    return null;
  return { kem, enc, ct };
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readBodyText(req, MAX_BODY)) as unknown;
    return isJsonObject(v) ? v : null;
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

type Target =
  | { kind: "ring" }
  | { kind: "wraps"; deviceId: string }
  | { kind: "recovery" }
  | { kind: "adopt" }
  | { kind: "reset" };

const METHODS: Record<Target["kind"], readonly string[]> = {
  ring: ["GET", "POST"],
  wraps: ["PUT", "DELETE"],
  recovery: ["GET", "PUT"],
  adopt: ["POST"],
  reset: ["POST"],
};

function targetOf(rest: readonly string[]): Target | null {
  if (rest.length === 0) return { kind: "ring" };
  if (rest.length === 2 && rest[0] === "wraps")
    return { kind: "wraps", deviceId: rest[1] ?? "" };
  if (rest.length === 1 && rest[0] === "recovery") return { kind: "recovery" };
  if (rest.length === 1 && rest[0] === "adopt") return { kind: "adopt" };
  if (rest.length === 1 && rest[0] === "reset") return { kind: "reset" };
  return null;
}

/** What every route after the gate knows about the request. */
interface Ctx {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  subject: string;
  device: DeviceRow;
  now: number;
}

export async function handleKeyring(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  rest: readonly string[],
): Promise<Response> {
  const target = targetOf(rest);
  if (target === null) return notFound();
  // LG-1: with the gate off the routes do not exist, whatever the product has enabled.
  if (!(await launchGateOn(env, db, "launch.syncE2e"))) return notFound();
  if (!(await keyringWanted(db, product))) return notFound();
  if (!METHODS[target.kind].includes(req.method)) return methodNotAllowed();

  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  const unusable =
    "error" in valid ||
    (product.services.license.enabled && !licenseUsable(valid.license, now));
  if (unusable) return wireError(401, ErrorCode.Unauthorized);
  const device = valid.device;
  const principal = await resolveSyncPrincipal(db, device);
  if (!principal || principal.product !== product.slug)
    return wireError(403, ErrorCode.AccountRequired);
  const c: Ctx = {
    req,
    env,
    db,
    product,
    subject: principal.subject,
    device,
    now,
  };

  try {
    switch (target.kind) {
      case "ring":
        return req.method === "GET"
          ? await getKeyring(db, product, c.subject, device, now)
          : await postKeyring(req, db, product, c.subject, device, now);
      case "wraps":
        return req.method === "DELETE"
          ? await deleteOwnWrap(db, product, c.subject, device, target.deviceId)
          : await putTargetWrap(
              req,
              db,
              product,
              c.subject,
              device,
              target.deviceId,
              now,
            );
      case "recovery":
        return req.method === "GET"
          ? await getRecoveryBlob(c)
          : await putRecovery(c);
      case "adopt":
        return await postAdopt(c);
      case "reset":
        return await postReset(c);
    }
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

/**
 * The body of a create or a reset: `{ringId, rootKid, wrap, recovery?}`, or null when any member
 * is malformed or the calling device has no keys (its own wrap would be useless, and is never
 * served, without keys to unwrap with). A reset's blob must be in the contract layout.
 */
async function readRingBody(
  req: Request,
  db: Db,
  product: Product,
  device: DeviceRow,
  strictBlob: boolean,
): Promise<{
  ringId: string;
  rootKid: string;
  wrap: WrapBody;
  recoveryCt: string | null;
} | null> {
  const o = await readJson(req);
  if (!o) return null;
  const { ringId, rootKid } = o;
  if (typeof ringId !== "string" || !RING_ID.test(ringId)) return null;
  if (typeof rootKid !== "string" || !KID.test(rootKid)) return null;
  const wrap = isJsonObject(o.wrap) ? wrapBody(o.wrap) : null;
  if (!wrap) return null;
  let recoveryCt: string | null = null;
  if (o.recovery !== undefined) {
    const ct = isJsonObject(o.recovery) ? o.recovery.ct : undefined;
    if (strictBlob ? !sealedBlob(ct) : !isB64urlField(ct, MAX_RECOVERY_CT))
      return null;
    recoveryCt = ct as string;
  }
  if (!(await getDeviceKeys(db, product.slug, device.device_id))) return null;
  return { ringId, rootKid, wrap, recoveryCt };
}

async function postKeyring(
  req: Request,
  db: Db,
  product: Product,
  subject: string,
  device: DeviceRow,
  now: number,
): Promise<Response> {
  const body = await readRingBody(req, db, product, device, false);
  if (!body) return badRequest();
  const { ringId, rootKid, wrap, recoveryCt } = body;

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

// ── Recovery, adopt and reset (U-36.3) ───────────────────────────────────────────────────────

/** One audit row for a key ring event: the device and the product, never a blob or a code. */
async function auditRing(
  c: Ctx,
  action: string,
  summary: string,
): Promise<void> {
  await appendAudit(c.db, {
    product: c.product.slug,
    id: randomId("aud"),
    at: c.now,
    actor_sub: null,
    actor_name: null,
    actor_email: null,
    action,
    target_kind: "device",
    target_id: c.device.device_id,
    parent_id: null,
    summary,
  });
}

/**
 * Tell the account (every verified address). It never fails the change: the audit row is the
 * record, and `sendSecurityNotice` leaves a count-only row when nobody could be reached.
 */
async function emailAccount(
  c: Ctx,
  notice: (input: {
    deviceLabel: string | null;
    productName: string;
    productSlug: string;
    at: number;
    origin: string;
  }) => NoticeMessage,
): Promise<void> {
  try {
    const accountId = await accountForSubject(c.db, c.product.slug, c.subject);
    if (!accountId) return;
    await sendSecurityNotice(
      c.env,
      c.db,
      accountId,
      null,
      notice({
        deviceLabel: c.device.label,
        productName: c.product.name,
        productSlug: c.product.slug,
        at: c.now,
        origin: new URL(c.req.url).origin,
      }),
      c.now,
    );
  } catch {
    // Swallowed on purpose: the change is made and audited.
  }
}

/** `403 forbidden` unless the calling device holds a current wrap: it holds the root. */
async function requireRoot(c: Ctx): Promise<Response | null> {
  return (await currentWrap(
    c.db,
    c.product.slug,
    c.subject,
    c.device.device_id,
  ))
    ? null
    : wireError(403, ErrorCode.Forbidden);
}

async function getRecoveryBlob(c: Ctx): Promise<Response> {
  // The device budget is counted before anything is read, so a device cannot probe past it. The
  // subject budget is only checked here and is counted once a blob is found.
  const subjectLimit = { ...RECOVERY_FETCH_SUBJECT_LIMIT, id: c.subject };
  if (
    !(await rateLimitOk(
      c.env,
      c.product.slug,
      { ...RECOVERY_FETCH_LIMIT, id: c.device.device_id },
      c.now,
    )) ||
    !(await rateLimitOk(c.env, c.product.slug, subjectLimit, c.now, true))
  )
    return wireError(429, "rate_limited");
  const blob = await getRecovery(c.db, c.product.slug, c.subject);
  if (!blob) return notFound();
  if (!(await rateLimitOk(c.env, c.product.slug, subjectLimit, c.now)))
    return wireError(429, "rate_limited");
  // The audit row comes first: a fetch that cannot be recorded is not served.
  await auditRing(c, "keyring.recovery.fetch", "Recovery data fetched");
  await emailAccount(c, recoveryStartedNotice);
  return json(blob);
}

async function putRecovery(c: Ctx): Promise<Response> {
  const o = await readJson(c.req);
  if (!o) return badRequest();
  const { ct } = o;
  const pos = epochKid(o.epoch, o.kid);
  if (!sealedBlob(ct) || !pos) return badRequest();
  const { epoch, kid } = pos;
  // A blob is sealed with the root, so only a device that holds it can write one.
  const refused = await requireRoot(c);
  if (refused) return refused;
  // The store keeps no epoch or kid of a blob; they must be the ring's (checked again in the
  // write, so a reset in between cannot take a blob sealed for the old root).
  const ring = await getRing(c.db, c.product.slug, c.subject);
  if (!ring || ring.epoch !== epoch || ring.rootKid !== kid) return conflict();
  if (
    !(await setRecovery(c.db, c.product.slug, c.subject, ct, c.now, {
      epoch,
      kid,
    }))
  )
    return conflict();
  await auditRing(c, "keyring.recovery.set", "Recovery code changed");
  await emailAccount(c, recoveryCodeChangedNotice);
  return noContent();
}

async function postAdopt(c: Ctx): Promise<Response> {
  const o = await readJson(c.req);
  if (!o) return badRequest();
  const { fromRingId, ct } = o;
  const pos = epochKid(o.epoch, o.kid);
  if (
    typeof fromRingId !== "string" ||
    !RING_ID.test(fromRingId) ||
    !pos ||
    !sealedBlob(ct)
  )
    return badRequest();
  // Sealing needs the current root.
  const refused = await requireRoot(c);
  if (refused) return refused;
  const { epoch, kid } = pos;
  // Only a root the server already names: the replaced ring while its 30 days run, or a candidate
  // a merge left. Anything else would be free storage.
  const ring = await getRing(c.db, c.product.slug, c.subject);
  const known =
    ring &&
    ((ring.previous &&
      ring.previous.until > c.now &&
      ring.previous.ringId === fromRingId &&
      ring.previous.kid === kid) ||
      ring.adopted.some(
        (a) => a.ringId === fromRingId && a.epoch === epoch && a.kid === kid,
      ));
  if (!known) return conflict();
  if (
    !(await addAdopted(
      c.db,
      c.product.slug,
      c.subject,
      { ringId: fromRingId, epoch, kid, ct },
      c.now,
    ))
  )
    return conflict();
  return noContent();
}

async function postReset(c: Ctx): Promise<Response> {
  const body = await readRingBody(c.req, c.db, c.product, c.device, true);
  if (!body) return badRequest();
  const { ringId, rootKid, wrap, recoveryCt } = body;

  // A reset replaces a ring; with none, the caller creates one. The new ring is a new id (the
  // old one lives on as `previous`), and the epoch starts at 1 like any new ring.
  const ring = await getRing(c.db, c.product.slug, c.subject);
  if (!ring) return conflict();
  // §13.11.4: epoch 1 may repeat across rings only because a ring id is never reused, so a reset
  // may not name an id this subject already had. The store keeps the current ring, the ring a
  // reset replaced (`previous`, forgotten after 30 days) and the roots sealed under the current
  // one (`adopted`: a replaced ring that was adopted, or a merged-in ring). That is every earlier
  // id it holds, and all of it is checked; an id it has already forgotten cannot be told from a
  // fresh one, which the 128-bit random id makes safe. A create needs no check: it only succeeds
  // when no ring exists, and there is then no current or previous id to repeat.
  if (
    ring.ringId === ringId ||
    ring.previous?.ringId === ringId ||
    ring.adopted.some((a) => a.ringId === ringId)
  )
    return conflict();
  const r = await resetRing(c.db, {
    product: c.product.slug,
    subject: c.subject,
    expectedRingId: ring.ringId,
    ringId,
    epoch: 1,
    rootKid,
    wrap: {
      ...wrap,
      deviceId: c.device.device_id,
      ringId,
      epoch: 1,
      kid: rootKid,
      by: c.device.device_id,
    },
    recoveryCt,
    now: c.now,
  });
  if (r === "conflict") return conflict();
  await auditRing(c, "keyring.reset", "Encryption reset");
  await emailAccount(c, encryptionResetNotice);
  return json({ ringId, epoch: 1 }, { status: 201 });
}
