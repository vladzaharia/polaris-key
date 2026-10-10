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
import {
  bearer,
  deleteTokenRecord,
  hashKey,
  type Db,
  type Env,
} from "../../core/platform.js";
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
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import {
  deviceMetadata,
  isValidClientDeviceId,
  readDeviceBody,
  DeviceTokenRotationLost,
  rotateDeviceToken,
  shapeDevice,
  shapeLicense,
} from "../../core/devices.js";
import { requireLicensedDevice } from "./auth.js";
import { authorizeDevice, type AuthzError } from "./authz.js";
import { logRefusal, type WaitUntil } from "../../core/refusals.js";
import { buildManageUrl } from "../../core/manageUrl.js";
import type { SettingsRegistry } from "../../core/settings/registry.js";
import {
  countKeyEntries,
  keyEntryGate,
  keyEntryLimitResponse,
  licenseOwnedResponse,
} from "../../core/keyEntries.js";

/**
 * The refusal link for an `authorizeDevice` failure (PX-W8, WIRE-CONTRACT-V4 §5.3): a
 * `manageUrl` for `device_limit` while the product's portal is on, else `undefined`. Built
 * only on that one refusal, so the success path never reads the portal settings.
 */
export async function refusalManageUrl(
  env: Env,
  db: Db,
  req: Request,
  product: Product,
  license: LicenseRow,
  err: AuthzError,
): Promise<string | undefined> {
  if (err.error !== "device_limit") return undefined;
  return buildManageUrl(env, db, req, product, {
    kind: "device_limit",
    license,
  });
}

/** Map an `authorizeDevice` failure to its HTTP response. Shared by /activate and /enroll so
 *  both surfaces report identical codes for identical causes. `manageUrl` (from
 *  `refusalManageUrl`) rides on `device_limit` only, and only when defined. */
export function authorizationError(
  err: AuthzError,
  manageUrl?: string,
): Response {
  switch (err.error) {
    case "unauthorized":
      // Also SEC-LIC-1's answer for a device id another licence holds: indistinguishable from a
      // refused key, saying neither who holds the id nor whether anything does.
      return errorResponse(401, ErrorCode.Unauthorized);
    case "device_limit":
      return errorResponse(403, ErrorCode.DeviceLimit, "device limit reached", {
        limit: err.limit,
        deviceCount: err.deviceCount,
        ...(manageUrl !== undefined ? { manageUrl } : {}),
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

/** The activation response's `license` member; defined in Core (`core/devices.ts`). */
export { shapeLicense };

async function activateWithKey(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  waitUntil?: WaitUntil,
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "activate", id: clientNetwork(req), limit: 30, windowSec: 60 },
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
  if (!isValidClientDeviceId(deviceId))
    return errorResponse(400, ErrorCode.BadRequest, "malformed device id");

  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active")
    return errorResponse(401, ErrorCode.Unauthorized);

  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!license) return errorResponse(401, ErrorCode.Unauthorized);
  const metadata = deviceMetadata(req);

  // PX-W9 (WIRE-CONTRACT-V4 §12.2): on an Identity product this is a key entry. An enrolled
  // device goes on as before; while the switch is on a new one is refused when the licence is in
  // an account (step 3, I-09) or past its limit (step 4), and otherwise its seat claim records
  // the entry (step 5).
  const gate = await keyEntryGate(
    { env, db, registry: settings },
    product,
    license,
    deviceId,
    now,
  );
  if (gate.kind === "refuse" || gate.kind === "owned") {
    await logRefusal(
      db,
      {
        product: product.slug,
        licenseId: license.id,
        deviceId,
        reason: gate.kind === "owned" ? "license_owned" : "key_entry_limit",
        at: now,
        platform: metadata.platform,
        arch: metadata.arch,
        userAgent: metadata.userAgent,
      },
      waitUntil,
    );
    // I-09 (§12.2 step 3): a licence in an account is reached by signing in, never by its key.
    if (gate.kind === "owned") return licenseOwnedResponse(env, req, product);
    return keyEntryLimitResponse(env, db, req, product, gate.keyEntries);
  }

  const authorized = await authorizeDevice(
    env,
    db,
    product,
    license,
    deviceId,
    now,
    {
      ...metadata,
      // PX-W13 §8 Q2: the body carries the fingerprint and the device label.
      ...(await readDeviceBody(req)),
      // I-05: key entry binds the device by key and NEVER sets the account binding.
      boundBy: "key",
      // UX-15: a refusal is logged after the answer, not before it.
      ...(waitUntil ? { waitUntil } : {}),
      ...(gate.kind === "admit"
        ? { keyEntry: { surface: "app" as const } }
        : {}),
    },
  );
  if ("error" in authorized)
    return authorizationError(
      authorized,
      await refusalManageUrl(env, db, req, product, license, authorized),
    );
  await touchKey(db, product.slug, keyHash, now);

  return json({
    token: authorized.token,
    schemaVersion: product.schemaVersion,
    device: shapeDevice(authorized.device, deviceId),
    license: shapeLicense(license),
    // §12.2 rule 5: the count after this entry (an enrolled device's re-entry included).
    ...(gate.kind === "admit"
      ? {
          keyEntries: {
            used: await countKeyEntries(db, product.slug, license.id),
            limit: gate.keyEntries.limit,
          },
        }
      : {}),
  });
}

/** POST /<product>/license/activate — exchange a license key for a per-device token. */
export async function handleActivate(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  waitUntil?: WaitUntil,
  /** ST-04's settings registry (`ServiceContext.settings`): the key-entry limit is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  return activateWithKey(req, env, db, product, now, waitUntil, settings);
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
      { bucket: "token", id: clientNetwork(req), limit: 30, windowSec: 60 },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many token requests");
  }
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");
  if (!isValidClientDeviceId(deviceId))
    return errorResponse(400, ErrorCode.BadRequest, "malformed device id");

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

  let token: string;
  try {
    token = await rotateDeviceToken(env, db, product, valid, now);
  } catch (e) {
    if (e instanceof DeviceTokenRotationLost)
      return errorResponse(401, ErrorCode.Unauthorized);
    throw e;
  }
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
  // Per-network limit before the token hash and the D1 lookups.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "deauthorize",
        id: clientNetwork(req),
        limit: 30,
        windowSec: 60,
      },
      Math.floor(Date.now() / 1000),
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many deauthorize requests");
  }
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
