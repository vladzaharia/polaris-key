/// <reference types="@cloudflare/workers-types" />

/**
 * Enrol and revoke a silent-restore key (I-49.5; WIRE-CONTRACT-V5 §12.11.8):
 *
 *     POST   /<p>/identity/restore   {restoreId?}  → 200 {status:"current"} | 201 {restoreId, secret}
 *     DELETE /<p>/identity/restore                 → 204
 *
 * Both take the device's own credential (`Authorization: Bearer pkeyt_…` and `X-PKey-Device`),
 * answer `no-store` and, with CORS, only the product's `web.origins`.
 *
 * ── POST IS GATED, DELETE IS NOT ────────────────────────────────────────────────────────────
 *
 * `POST` mints a credential, so it answers `404 not_found` unless `restoreServed` says yes (the
 * launch gate, then the product setting; Identity is on, or the registry would not have routed).
 * `DELETE` revokes one, and a revocation must reach a row written while the feature was on: it
 * runs whatever the gate, the setting or the Identity toggle say, needs only the device bearer
 * and answers `204` whether or not a row existed.
 *
 * ── CURRENT OR NEW ──────────────────────────────────────────────────────────────────────────
 *
 * `restoreId` is "current" only when it is THIS device's live row for the device's own subject
 * and under 90 days old (`checkRestoreKey`); anything else, including another device's id for the
 * same person, mints a new key that replaces this device's row. The secret is in the `201` once.
 *
 * ── LIMITS ──────────────────────────────────────────────────────────────────────────────────
 *
 * 20 a minute per client network before anything is read, and 10 a day per device after the
 * bearer is known; both fail closed (`core/rateLimit.ts`). `DELETE` shares the account routes'
 * budget, which fails open: it mints nothing.
 */

import type {
  RestoreKeyIssued,
  RestoreKeyCurrent,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  wireError,
} from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { ACCOUNT_RATE, deviceHolder, deviceOf } from "../attach.js";
import { restoreServed } from "./gate.js";
import {
  RESTORE_ID_PATTERN,
  checkRestoreKey,
  mintRestoreKey,
  revokeDeviceRestore,
} from "./store.js";

/** Enrolment: 20 a minute per client network. */
export const RESTORE_KEY_NET_RATE = {
  bucket: "identityRestoreKeyNet",
  limit: 20,
  windowSec: 60,
};
/** Enrolment: 10 a day per device. */
export const RESTORE_KEY_DEVICE_RATE = {
  bucket: "identityRestoreKey",
  limit: 10,
  windowSec: 86_400,
};

/** `{restoreId?}` is the largest body: an id is 25 bytes. */
const BODY_CAP = 1024;

const noStore = (res: Response): Response => {
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
};

/** The body's `restoreId`: `undefined` when absent, `null` when the body is not what §12.11.8 allows. */
async function parseBody(req: Request): Promise<string | undefined | null> {
  let text: string;
  try {
    text = await readBodyText(req, BODY_CAP);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return null;
    throw e;
  }
  if (text.trim() === "") return undefined;
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  if (keys.some((k) => k !== "restoreId")) return null;
  const id = (o as { restoreId?: unknown }).restoreId;
  if (id === undefined) return undefined;
  return typeof id === "string" && RESTORE_ID_PATTERN.test(id) ? id : null;
}

export async function handleRestoreKey(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method === "DELETE") return revoke(req, env, db, product, now);
  if (req.method !== "POST") return methodNotAllowed();

  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...RESTORE_KEY_NET_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return noStore(wireError(429, "rate_limited"));
  // The gate before any lookup: a feature that is off reads nothing and mints nothing.
  if (!(await restoreServed(env, db, product.slug)))
    return noStore(wireError(404, ErrorCode.NotFound));
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return noStore(auth);
  const { deviceId, valid } = auth;
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...RESTORE_KEY_DEVICE_RATE, id: deviceId },
      now,
    ))
  )
    return noStore(wireError(429, "rate_limited"));

  const restoreId = await parseBody(req);
  if (restoreId === null) return noStore(wireError(400, ErrorCode.BadRequest));

  // The account signed in on THIS device, never one the request names.
  const holder = await deviceHolder(
    env,
    db,
    product.slug,
    valid.device.subject,
    now,
  );
  if (holder === "unavailable")
    return noStore(wireError(503, "erasure_ledger_unavailable"));
  if (!holder) return noStore(wireError(403, ErrorCode.AccountRequired));

  if (
    restoreId !== undefined &&
    (await checkRestoreKey(db, {
      product: product.slug,
      deviceId,
      subject: holder.subject,
      restoreId,
      now,
    }))
  )
    return noStore(json({ status: "current" } satisfies RestoreKeyCurrent));

  const minted = await mintRestoreKey(env, db, {
    product: product.slug,
    deviceId,
    subject: holder.subject,
    now,
  });
  return noStore(json(minted satisfies RestoreKeyIssued, { status: 201 }));
}

/** `DELETE`: this device's key goes, whatever the gate says. Only the device bearer is needed. */
async function revoke(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...ACCOUNT_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return noStore(wireError(429, "rate_limited"));
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return noStore(auth);
  await revokeDeviceRestore(db, product.slug, auth.deviceId);
  return noStore(new Response(null, { status: 204 }));
}
