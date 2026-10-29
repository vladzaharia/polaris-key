/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/nearby/start` (I-40.4; WIRE-CONTRACT-V5 §12.11.5): the new device D asks a
 * signed-in device nearby to approve its sign-in.
 *
 *   ← {signKey, agreeKey, deviceName?, proof}, `X-PKey-Device`
 *   → 201 {request: "nr_…", expiresIn: 300, interval: 3}      `no-store`
 *
 * ── THE ORDER OF CHECKS ─────────────────────────────────────────────────────────────────────
 *
 *   the three gates (Identity is on when the route is reached, `identity.nearby`,
 *   `launch.identityNearby`; each off state is `404 not_found`, even for a malformed body), the body's shape, the network budget, the device
 *   header, the keys (§15.8's rules, the held-key rule, an `agreeKey` held by another device), the
 *   `nearby-start` proof checked with the body's `signKey`, the existing-credential rule (Q8), the
 *   label (§12.7.1), THEN the record is written and the handle answered.
 *
 * Every refusal about the keys is one `400 device_keys_invalid` and every refusal of the proof is
 * one `400 invalid_grant`, so the answers do not say which check failed.
 *
 * ── Q8: A DEVICE ID THAT ALREADY HOLDS A CREDENTIAL ─────────────────────────────────────────
 *
 * It must prove the device with its own bearer or its registered signing key; otherwise
 * `400 device_keys_invalid`. The credential is replaced at the poll, so a bare device id must not
 * be able to name a signed-in device and take its place.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────────────────────
 *
 * The client network is stored only as the peppered `netHash`; no raw address is kept. The handle
 * itself is never stored, only its peppered hash (the store address).
 */

import {
  NEARBY_POLL_INTERVAL_SECONDS,
  NEARBY_REQUEST_TTL_SECONDS,
  type NearbyStartResponse,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE, type DeviceMetadata } from "@polaris-key/protocol/core";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { bearer } from "../../../platform/http.js";
import { randomToken } from "../../../platform/random.js";
import { BodyTooLargeError, readBodyText } from "../../../core/cappedBody.js";
import {
  ErrorCode,
  json,
  methodNotAllowed,
  wireError,
} from "../../../core/errors.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import {
  deviceMetadata,
  isValidClientDeviceId,
  validateDeviceToken,
} from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { getProduct } from "../../../core/products/store.js";
import {
  agreeKeyHeldElsewhere,
  deviceSignKey,
  validateDeviceKeys,
} from "../../../core/devices/keys.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { readPlatformSignIn } from "../platformSignIn.js";
import {
  createNearby,
  hasClientNetwork,
  nearbyNetHash,
  nearbyRef,
} from "./nearbyStore.js";

/** `start`: 10 a minute per client network, failing closed (§12.11.5 rule 12). */
export const NEARBY_START_RATE = {
  bucket: "identityNearbyStart",
  limit: 10,
  windowSec: 60,
} as const;

/** Two keys, a proof and a label. */
const MAX_BODY = 4 * 1024;
/** A label is cut to 64 code points after normalisation; this bounds what is read for it. */
const MAX_NAME = 1024;

const keysInvalid = (): Response => wireError(400, ErrorCode.DeviceKeysInvalid);

interface StartBody {
  signKey: string;
  agreeKey: string;
  deviceName: string | undefined;
  proof: string;
}

/** A JSON object body of at most `max` bytes, `"too_large"` over it, or null when it is anything else. */
async function readJsonObject(
  req: Request,
  max: number,
): Promise<Record<string, unknown> | "too_large" | null> {
  let o: unknown;
  try {
    o = JSON.parse(await readBodyText(req, max));
  } catch (e) {
    return e instanceof BodyTooLargeError ? "too_large" : null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  return o as Record<string, unknown>;
}

/**
 * Whether nearby approval is off for the product: the operator gate `launch.identityNearby`, the
 * product row, or `identity.nearby`. Checked before any body is read, so an off route is
 * indistinguishable from one that does not exist (§12.11.5 rule 13). Identity being on is the
 * router's.
 */
async function nearbyOff(env: Env, db: Db, product: Product): Promise<boolean> {
  if (!(await launchGateOn(env, db, "launch.identityNearby"))) return true;
  const row = await getProduct(db, product.slug);
  if (!row) return true;
  return !(await readPlatformSignIn(db, row)).nearby;
}

/**
 * The first steps of a nearby route that takes a body: the method, the gates, then the shape. Returns the
 * parsed body, or the response to answer (`404` off, `413` too large, `400` malformed).
 */
export async function gatedBody<T>(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  max: number,
  parse: (o: Record<string, unknown>) => T | null,
): Promise<T | Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (await nearbyOff(env, db, product))
    return wireError(404, ErrorCode.NotFound);
  const o = await readJsonObject(req, max);
  if (o === "too_large") return wireError(413, "body_too_large");
  const body = o === null ? null : parse(o);
  return body ?? wireError(400, ErrorCode.BadRequest);
}

/**
 * The first steps of `start` and `poll`: the gates, the shape, the per-network budget (failing
 * closed), then the `X-PKey-Device` header. Returns the body and the device id, or the response
 * to answer.
 */
export async function gatedDeviceBody<T>(
  cx: { req: Request; env: Env; db: Db; product: Product; now: number },
  max: number,
  parse: (o: Record<string, unknown>) => T | null,
  rate: { bucket: string; limit: number; windowSec: number },
): Promise<{ body: T; deviceId: string } | Response> {
  const { req, env, db, product, now } = cx;
  const body = await gatedBody(req, env, db, product, max, parse);
  if (body instanceof Response) return body;
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...rate, id: clientNetwork(req) },
      now,
    ))
  )
    return wireError(429, "rate_limited");
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!isValidClientDeviceId(deviceId))
    return wireError(400, ErrorCode.BadRequest);
  return { body, deviceId };
}

/** The body, or null when it is not exactly the documented shape. */
function parseBody(r: Record<string, unknown>): StartBody | null {
  const { signKey, agreeKey, deviceName, proof } = r;
  if (
    typeof signKey !== "string" ||
    typeof agreeKey !== "string" ||
    typeof proof !== "string"
  )
    return null;
  if (deviceName !== undefined) {
    if (typeof deviceName !== "string" || deviceName.length > MAX_NAME)
      return null;
  }
  return {
    signKey,
    agreeKey,
    deviceName: deviceName as string | undefined,
    proof,
  };
}

/** The client metadata headers, as the request record keeps them. */
function metaOf(req: Request, label: string | null): DeviceMetadata {
  const m = deviceMetadata(req);
  return {
    ...(label !== null ? { label } : {}),
    ...(m.platform ? { platform: m.platform } : {}),
    ...(m.arch ? { arch: m.arch } : {}),
    ...(m.appVersion ? { appVersion: m.appVersion } : {}),
    ...(m.sdkName ? { sdkName: m.sdkName } : {}),
    ...(m.sdkVersion ? { sdkVersion: m.sdkVersion } : {}),
  };
}

export async function handleNearbyStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  // 1. The gates, then the shape (§12.11.5 rule 13: an off route is 404 even for a bad body);
  // 2. the network budget; 3. X-PKey-Device.
  const got = await gatedDeviceBody(
    { req, env, db, product, now },
    MAX_BODY,
    parseBody,
    NEARBY_START_RATE,
  );
  if (got instanceof Response) return got;
  const { body: asked, deviceId } = got;

  // Proximity needs a client network: with none, two callers would compare equal, so refuse.
  if (!hasClientNetwork(req)) return wireError(503, "unavailable");

  // 4. The keys: well formed, the held-key rule, an agreement key no other device holds.
  const { signKey, agreeKey } = asked;
  if (!validateDeviceKeys({ signKey, agreeKey })) return keysInvalid();
  const held = await deviceSignKey(db, product.slug, deviceId);
  if (held !== null && held !== signKey) return keysInvalid();
  if (await agreeKeyHeldElsewhere(db, product.slug, agreeKey, deviceId))
    return keysInvalid();

  // 5. The proof, by the key the body names (the held-key rule has made it the held key, if any).
  if (
    !(await verifyDeviceProof({
      purpose: "nearby-start",
      product: product.slug,
      deviceId,
      value: `${signKey}.${agreeKey}`,
      tokenHash: "-",
      signKey,
      sig: asked.proof,
    }))
  )
    return wireError(400, ErrorCode.InvalidGrant);

  // 6. Q8: a device id that holds a credential proves the device, by its registered signing key
  // (the proof above was made with it) or by its own bearer.
  const device = await getDevice(db, product.slug, deviceId);
  const holdsCredential =
    device !== null && device.status === "authorized" && !!device.token_hash;
  const token = bearer(req);
  const byBearer =
    token !== null &&
    !(
      "error" in
      (await validateDeviceToken(env, db, product, token, now, { deviceId }))
    );
  const proven = held !== null || byBearer;
  if (holdsCredential && !proven) return keysInvalid();

  // 7. The label, as §12.7.1.
  const label = normalizeDeviceLabel(asked.deviceName);

  // 8. Write the record, then answer. The handle is 128 random bits; a taken address is retried.
  const netHash = await nearbyNetHash(env, req);
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = `nr_${randomToken(16)}`;
    const ref = await nearbyRef(env, product.slug, request);
    if (!ref) throw new Error("nearby handle has no address");
    let written: boolean;
    try {
      written = await createNearby(env, ref, {
        product: product.slug,
        deviceId,
        signKey,
        agreeKey,
        label,
        meta: metaOf(req, label),
        netHash,
        startedAt: now,
        proven,
      });
    } catch {
      // The store could not record it, so no handle is handed out.
      return wireError(503, "unavailable", {});
    }
    if (!written) continue;
    const out: NearbyStartResponse = {
      request,
      expiresIn: NEARBY_REQUEST_TTL_SECONDS,
      interval: NEARBY_POLL_INTERVAL_SECONDS,
    };
    return json(out, { status: 201 });
  }
  return wireError(503, "unavailable");
}
