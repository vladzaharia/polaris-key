/// <reference types="@cloudflare/workers-types" />

/**
 * The activation hot path: key → token, token re-acquire, self-deauthorize.
 *
 * Moved from `licensing.ts` under the v3 namespace (`POST /<p>/license/{activate,token,
 * deauthorize}`, plan §R1) with the bodies unchanged. The two handlers that did NOT come with
 * them are the ones v3 abolishes rather than renames:
 *
 *   - `GET /<p>/config`  split into two signed documents; `document.ts` owns License's half.
 *   - `GET /<p>/account` removed outright — its licence half is the license document and its
 *                        device half is `GET /<p>/devices`, both of which already existed.
 *
 * Product isolation is structural and unchanged: every repo/KV call is product-scoped, the
 * signing key is the product's, and the document carries `aud = product`.
 */

import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import type { Env, Db } from "../../core/platform.js";
import { bearer, hashKey, deleteTokenRecord } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import {
  errorResponse,
  ErrorCode,
  json,
  methodNotAllowed,
} from "../../core/errors.js";
import {
  getKey,
  getLicense,
  setDeviceStatus,
  touchKey,
  type LicenseRow,
} from "../../core/data.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import {
  deviceMetadata,
  readFingerprint,
  rotateDeviceToken,
  shapeDevice,
} from "../../core/devices.js";
import { requireLicensedDevice } from "./auth.js";
import { authorizeDevice, type AuthzError } from "./authz.js";

/** Map an `authorizeDevice` failure to its HTTP response. Shared by /activate and /enroll so
 *  both surfaces report identical codes for identical causes. */
export function authorizationError(err: AuthzError): Response {
  switch (err.error) {
    case "unauthorized":
      return errorResponse(401, ErrorCode.Unauthorized);
    case "device_limit":
      return errorResponse(403, ErrorCode.DeviceLimit, "device limit reached", {
        limit: err.limit,
        deviceCount: err.deviceCount,
      });
    case "fingerprint_required":
      return errorResponse(
        403,
        ErrorCode.FingerprintRequired,
        "this tier requires a hardware fingerprint",
      );
    case "hardware_mismatch":
      // 409, not 403: the caller can resolve this by retrying activation, which re-binds the
      // new hardware. A flat 403 would read as "never going to work".
      return errorResponse(
        409,
        ErrorCode.HardwareMismatch,
        "hardware changed; re-activation required",
        { drift: err.drift, changed: err.changed },
      );
  }
}

export function shapeLicense(license: LicenseRow) {
  return {
    id: license.id,
    status: license.status,
    name: license.name,
    email: license.email,
    tierId: license.tier_id,
    activatedAt: license.activated_at,
    expiresAt: license.expires_at,
    maxOfflineDays: license.max_offline_days,
    channels: parseJsonArray(license.channels_json),
    minVersion: license.min_version,
    maxVersion: license.max_version,
  };
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed.filter((item) => typeof item === "string") as string[])
      : [];
  } catch {
    return [];
  }
}

async function activateWithKey(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "activate", id: clientIp(req), limit: 30, windowSec: 60 },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many activation attempts");
  }
  const key = bearer(req);
  if (!key) return errorResponse(401, ErrorCode.Unauthorized);
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");

  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active")
    return errorResponse(401, ErrorCode.Unauthorized);

  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!license) return errorResponse(401, ErrorCode.Unauthorized);
  const authorized = await authorizeDevice(
    env,
    db,
    product,
    license,
    deviceId,
    now,
    {
      ...deviceMetadata(req),
      fingerprint: await readFingerprint(req),
      // I-05: key entry binds the device by key and NEVER sets the account binding.
      boundBy: "key",
    },
  );
  if ("error" in authorized) return authorizationError(authorized);
  await touchKey(db, product.slug, keyHash, now);

  return json({
    token: authorized.token,
    schemaVersion: product.schemaVersion,
    device: shapeDevice(authorized.device, deviceId),
    license: shapeLicense(license),
  });
}

/** POST /<product>/license/activate — exchange a license key for a per-device token. */
export async function handleActivate(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  return activateWithKey(req, env, db, product, now);
}

/** POST /<product>/license/token — replace the current token for an already-authorized device.
 *  Callers must present the current bearer token and the matching device id. */
export async function handleToken(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "token", id: clientIp(req), limit: 30, windowSec: 60 },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many token requests");
  }
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");

  const currentToken = bearer(req);
  const valid = await requireLicensedDevice(
    env,
    db,
    product,
    currentToken,
    now,
    { deviceId },
  );
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);

  const token = await rotateDeviceToken(env, db, product, valid, now);
  return json({ token, schemaVersion: product.schemaVersion });
}

/** POST /<product>/license/deauthorize — self-deauthorize the bearer token's device. */
export async function handleDeauthorize(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const token = bearer(req);
  if (!token) return errorResponse(401, ErrorCode.Unauthorized);
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const valid = await requireLicensedDevice(
    env,
    db,
    product,
    token,
    Math.floor(Date.now() / 1000),
  );
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  await setDeviceStatus(
    db,
    product.slug,
    valid.device.device_id,
    "deauthorized",
  );
  await deleteTokenRecord(env, product.slug, tokenHash);
  return json({ ok: true });
}
