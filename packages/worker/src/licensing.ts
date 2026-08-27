/// <reference types="@cloudflare/workers-types" />

// The licensing hot path: activate (key -> token), token re-acquire, /config (token ->
// signed doc), deauthorize. Product isolation is structural — every repo/KV call is
// product-scoped, the signing key is the product's, and the doc carries aud = product.
//
// The DEVICE principal underneath all of this is core's: token validation and rotation,
// `/devices` self-service, the report/facts surface, device metadata and the activation-body
// fingerprint reader all live in `core/devices.ts` and are imported from there.

import { HEADER_CHANNEL, HEADER_DEVICE, HEADER_VERSION } from "@plrs/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./core/products.js";
import { bearer } from "./http.js";
import {
  errorResponse,
  ErrorCode,
  json,
  methodNotAllowed,
} from "./core/errors.js";
import { checkBuildGate, tighterMin, tighterMax } from "./gate.js";
import { Catalog } from "@plrs/catalog";
import { buildDoc, computeETag, validatePayload } from "./configDoc.js";
import { signDoc } from "./core/signing.js";
import {
  getKey,
  getLicense,
  getActiveSchema,
  listDevicesByLicense,
  touchKey,
  setDeviceStatus,
  upsertDevice,
  type LicenseRow,
} from "./repo.js";
import { hashKey } from "./crypto.js";
import { deleteTokenRecord } from "./kv.js";
import { clientIp, rateLimitOk } from "./core/rateLimit.js";
import {
  deviceMetadata,
  readFingerprint,
  rotateDeviceToken,
  shapeDevice,
  validateDeviceToken,
} from "./core/devices.js";
import {
  authorizeDevice,
  docProfile,
  resolveEffective,
  type AuthzError,
} from "./licenseCore.js";

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
    { ...deviceMetadata(req), fingerprint: await readFingerprint(req) },
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

/** POST /<product>/activate — exchange a license key for a per-device token. */
export async function handleActivate(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  return activateWithKey(req, env, db, product, now);
}

/** POST /<product>/token — replace the current token for an already-authorized device.
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
  const valid = await validateDeviceToken(env, db, product, currentToken, now, {
    deviceId,
  });
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);

  const token = await rotateDeviceToken(env, db, product, valid, now);
  return json({ token, schemaVersion: product.schemaVersion });
}

/** GET /<product>/account — return the current license and friendly device list. */
export async function handleAccount(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  const token = bearer(req);
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  const devices = await listDevicesByLicense(
    db,
    product.slug,
    valid.license.id,
  );
  return json({
    product: { slug: product.slug, name: product.name },
    license: shapeLicense(valid.license),
    currentDeviceId: valid.device.device_id,
    devices: devices.map((device) =>
      shapeDevice(device, valid.device.device_id),
    ),
  });
}

/** GET /<product>/config — return the signed managed-config doc for the bearer token. */
export async function handleConfig(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  const token = bearer(req);
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  const meta = deviceMetadata(req);
  await upsertDevice(db, {
    ...valid.device,
    last_seen: now,
    ua: meta.userAgent ?? valid.device.ua,
    platform: meta.platform ?? valid.device.platform ?? null,
    arch: meta.arch ?? valid.device.arch ?? null,
    app_version: meta.appVersion ?? valid.device.app_version ?? null,
    sdk_name: meta.sdkName ?? valid.device.sdk_name ?? null,
    sdk_version: meta.sdkVersion ?? valid.device.sdk_version ?? null,
  });

  let payload = await resolveEffective(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
    { tighterMin, tighterMax },
    // R12-02 — `env` opens the sealed managed secrets. They are sealed at rest now
    // (admin/lib/overrides.ts), so without this the still-sealed envelope reaches
    // validatePayload, fails the catalog check, and is pruned fail-closed — silently
    // dropping every managed secret from the signed doc. `/config` is the primary
    // delivery surface, so this is the call site that matters most.
    env,
  );

  // Defense-in-depth: re-validate the merged config/secret keys against the active catalog
  // and drop anything unknown or invalid before signing (a stale/misconfigured override must
  // never reach the client). Entitlements pass through — the gate below governs them.
  const schemaRow = await getActiveSchema(db, product.slug);
  if (schemaRow) {
    try {
      payload = validatePayload(
        payload,
        new Catalog(JSON.parse(schemaRow.catalog_json)),
      );
    } catch {
      return errorResponse(
        500,
        "catalog_unavailable",
        "active catalog could not validate the config payload",
      );
    }
  }

  const version = req.headers.get(HEADER_VERSION) ?? "0.0.0";
  const channel = req.headers.get(HEADER_CHANNEL) ?? undefined;
  const gate = checkBuildGate({
    version,
    channelHeader: channel,
    entitlements: payload.entitlements,
    compatMin: product.compatMin,
    compatMax: product.compatMax,
  });
  if (!gate.ok) {
    return errorResponse(403, ErrorCode.NotEntitled, "build not entitled", {
      reason: gate.reason,
      allowedRange: gate.allowedRange,
    });
  }

  const maxOfflineDays =
    valid.license.max_offline_days ?? product.defaultMaxOfflineDays;
  const doc = buildDoc({
    schemaVersion: product.schemaVersion,
    aud: product.slug,
    licenseId: valid.license.id,
    deviceId: valid.device.device_id,
    now,
    maxOfflineDays,
    profile: docProfile(valid.license),
    payload,
  });
  const etag = await computeETag(doc);
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const jws = await signDoc(doc, product.signingKeyPem, product.signingKid);
  return new Response(jws, {
    status: 200,
    headers: {
      "content-type": "application/jwt",
      etag,
      "cache-control": "no-store",
    },
  });
}

/** POST /<product>/deauthorize — self-deauthorize the bearer token's device. */
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
  const valid = await validateDeviceToken(
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
