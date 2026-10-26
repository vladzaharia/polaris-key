/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/nonce` (I-13.2; WIRE-CONTRACT-V5 §12.11.2): the nonce a native sign-in hands
 * to the platform provider, held once so the exchange can take it.
 *
 *   ← {signKey, agreeKey}, `X-PKey-Device`
 *   → {nonce, expiresIn: 300}      `no-store`
 *
 * The nonce is 32 random bytes in base64url. It is stored in the single-use store under the peppered
 * hash of itself, with the product, the device and the signing key's thumbprint, so the exchange can
 * require all three to match. Nothing is written to D1 here: the exchange registers both keys.
 * A device that already has a registered signing key must present that key. Every refusal about
 * the keys is one `400 device_keys_invalid`, so the answer does not say which check failed.
 * Limits: 30 a minute per client network and 10 a minute per device, failing closed.
 */

import {
  EXCHANGE_NONCE_PATTERN,
  EXCHANGE_NONCE_TTL_SECONDS,
  type ExchangeNonceRequest,
  type ExchangeNonceResponse,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { base64UrlDecode } from "@polaris-key/jws";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { b64urlEncode } from "../../../platform/bytes.js";
import { hashKey } from "../../../platform/crypto.js";
import { randomToken } from "../../../platform/random.js";
import { sha256 } from "../../../platform/hash.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  wireError,
} from "../../../core/errors.js";
import { isValidClientDeviceId } from "../../../core/devices.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  deviceSignKey,
  validateDeviceKeys,
} from "../../../core/devices/keys.js";

/** What the store holds for a live nonce. */
export interface ExchangeNonceRecord {
  product: string;
  deviceId: string;
  /** Base64url SHA-256 of the raw signing key. */
  keyThumbprint: string;
  /** The X25519 key named with the signing key; the exchange registers both (I-13.4). */
  agreeKey: string;
  issuedAt: number;
}

/** Two short base64url strings. */
const MAX_BODY = 1024;

export const NONCE_NETWORK_LIMIT = {
  bucket: "identityNonce",
  limit: 30,
  windowSec: 60,
} as const;
export const NONCE_DEVICE_LIMIT = {
  bucket: "identityNonceDevice",
  limit: 10,
  windowSec: 60,
} as const;

const NONCE_SHAPE = new RegExp(EXCHANGE_NONCE_PATTERN);

/** The thumbprint a nonce is bound to: base64url SHA-256 of the 32-byte signing key. */
export async function signKeyThumbprint(signKey: string): Promise<string> {
  return b64urlEncode(await sha256(base64UrlDecode(signKey)));
}

/** The store address of a nonce; a nonce of the wrong shape has none. */
export async function exchangeNonceRef(
  env: Env,
  product: string,
  nonce: string,
): Promise<ArtefactRef | null> {
  if (!NONCE_SHAPE.test(nonce)) return null;
  return artefactRef(
    "exchange-nonce",
    `${product}:${await hashKey(nonce, env.KEY_HASH_PEPPER)}`,
  );
}

/**
 * Take a nonce once. It answers its record only when the nonce is live and was issued for this
 * product, device and signing key; any other case answers null. The take spends the nonce, so a
 * presentation under another binding burns it.
 */
export async function consumeExchangeNonce(
  env: Env,
  product: string,
  nonce: string,
  deviceId: string,
  signKey: string,
): Promise<ExchangeNonceRecord | null> {
  const ref = await exchangeNonceRef(env, product, nonce);
  if (!ref) return null;
  const raw = await consumeArtefact(env, ref);
  if (!raw) return null;
  let rec: ExchangeNonceRecord;
  try {
    rec = JSON.parse(raw) as ExchangeNonceRecord;
  } catch {
    return null;
  }
  if (rec.product !== product || rec.deviceId !== deviceId) return null;
  if (rec.keyThumbprint !== (await signKeyThumbprint(signKey))) return null;
  return rec;
}

export async function handleExchangeNonce(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!isValidClientDeviceId(deviceId))
    return wireError(400, ErrorCode.BadRequest);

  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...NONCE_NETWORK_LIMIT, id: clientNetwork(req) },
      now,
    )) ||
    !(await rateLimitOk(
      env,
      product.slug,
      { ...NONCE_DEVICE_LIMIT, id: deviceId },
      now,
    ))
  )
    return wireError(429, "rate_limited");

  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(await readBodyText(req, MAX_BODY)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v))
      return wireError(400, ErrorCode.BadRequest);
    o = v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof BodyTooLargeError) return wireError(413, "body_too_large");
    return wireError(400, ErrorCode.BadRequest);
  }
  const { signKey, agreeKey } = o;
  if (typeof signKey !== "string" || typeof agreeKey !== "string")
    return wireError(400, ErrorCode.BadRequest);
  const keys: ExchangeNonceRequest = { signKey, agreeKey };
  if (!validateDeviceKeys(keys))
    return wireError(400, ErrorCode.DeviceKeysInvalid);

  const held = await deviceSignKey(db, product.slug, deviceId);
  if (held !== null && held !== signKey)
    return wireError(400, ErrorCode.DeviceKeysInvalid);

  const nonce = randomToken(32);
  const ref = await exchangeNonceRef(env, product.slug, nonce);
  if (!ref) throw new Error("exchange nonce has no address");
  const record: ExchangeNonceRecord = {
    product: product.slug,
    deviceId,
    keyThumbprint: await signKeyThumbprint(signKey),
    agreeKey,
    issuedAt: now,
  };
  await putArtefact(
    env,
    ref,
    JSON.stringify(record),
    EXCHANGE_NONCE_TTL_SECONDS,
    { ifAbsent: true },
  );
  const body: ExchangeNonceResponse = {
    nonce,
    expiresIn: EXCHANGE_NONCE_TTL_SECONDS,
  };
  return json(body);
}
