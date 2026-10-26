/// <reference types="@cloudflare/workers-types" />

/**
 * `PUT /<p>/devices/keys` (CC-03.2, plans/CC-01-cloud-connect.md §2.8): a device registers or
 * rotates its two public keys.
 *
 *   ← {signKey, agreeKey, issuedAt, sig}      `sig` is the `pkey-proof/1` `keys` proof
 *   → {keySeq}
 *
 * The device bearer authenticates the request and names the device; the proof shows the sender
 * holds the private half of `signKey`. Checks, in order: the device token is live, the body is
 * well formed, the proof verifies (keys valid, `issuedAt` within the skew window, signature), the
 * keys are not already registered (answered `keySeq` unchanged, no budget spent), the device is
 * within 4 changes a day, then the write. A rejected key, a failed proof and an `agreeKey` another
 * device holds all answer one `400 device_keys_invalid`, so the answer says nothing about which
 * check failed or which keys exist. The rate limit fails closed.
 */

import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import type { Product } from "../products.js";
import { bearer } from "../../platform/http.js";
import { BodyTooLargeError, readBodyText } from "../cappedBody.js";
import { ErrorCode, json, methodNotAllowed, wireError } from "../errors.js";
import { rateLimitOk } from "../rateLimit.js";
import { licenseUsable, validateDeviceToken } from "../devices.js";
import {
  DeviceKeysConflictError,
  DeviceKeysInvalidError,
  getDeviceKeys,
  upsertDeviceKeys,
  verifyKeyPop,
} from "./keys.js";
import { notifyDeviceChange } from "./lifecycle.js";

/** A change a device may make to its keys, per day (a registration counts). */
export const DEVICE_KEYS_LIMIT = {
  bucket: "deviceKeys",
  limit: 4,
  windowSec: 86_400,
} as const;

/** Four short base64url strings and an integer: far under this. */
const MAX_BODY = 2 * 1024;

function invalid(): Response {
  return wireError(400, ErrorCode.DeviceKeysInvalid);
}

export async function handleDeviceKeys(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "PUT") return methodNotAllowed();
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);
  if (product.services.license.enabled && !licenseUsable(valid.license, now))
    return wireError(401, ErrorCode.Unauthorized);
  const deviceId = valid.device.device_id;

  let text: string;
  try {
    text = await readBodyText(req, MAX_BODY);
  } catch (e) {
    if (e instanceof BodyTooLargeError) return wireError(413, "body_too_large");
    throw e;
  }
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return wireError(400, ErrorCode.BadRequest);
    o = v as Record<string, unknown>;
  } catch {
    return wireError(400, ErrorCode.BadRequest);
  }
  const { signKey, agreeKey, issuedAt, sig } = o;
  if (
    typeof signKey !== "string" ||
    typeof agreeKey !== "string" ||
    typeof sig !== "string" ||
    typeof issuedAt !== "number" ||
    !Number.isSafeInteger(issuedAt)
  )
    return wireError(400, ErrorCode.BadRequest);

  const proven = await verifyKeyPop({
    product: product.slug,
    deviceId,
    signKey,
    agreeKey,
    issuedAt,
    sig,
    now,
  });
  if (!proven) return invalid();

  // The keys the device already holds: answer without spending the day's budget, so a client
  // may re-send its registration on every start.
  const current = await getDeviceKeys(db, product.slug, deviceId);
  if (current && current.sign_key === signKey && current.agree_key === agreeKey)
    return json({ keySeq: current.key_seq });

  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...DEVICE_KEYS_LIMIT, id: deviceId },
      now,
    ))
  )
    return wireError(429, "rate_limited");

  try {
    const r = await upsertDeviceKeys(
      db,
      product.slug,
      deviceId,
      { signKey, agreeKey },
      now,
      issuedAt,
    );
    if (r.changed)
      await notifyDeviceChange(
        { db, env, now },
        { product: product.slug, deviceId, kind: "keys", keySeq: r.keySeq },
      );
    return json({ keySeq: r.keySeq });
  } catch (e) {
    if (
      e instanceof DeviceKeysInvalidError ||
      e instanceof DeviceKeysConflictError
    )
      return invalid();
    throw e;
  }
}
