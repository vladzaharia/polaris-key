/// <reference types="@cloudflare/workers-types" />

// The licensing hot path: enroll (key -> token), token re-acquire, /config (token ->
// signed doc), report, deauthorize. Product isolation is structural — every repo/KV call
// is product-scoped, the signing key is the product's, and the doc carries aud = product.

import {
  HEADER_ARCH,
  HEADER_CHANNEL,
  HEADER_DEVICE,
  HEADER_PLATFORM,
  HEADER_SDK_NAME,
  HEADER_SDK_VERSION,
  HEADER_VERSION,
} from "@polaris-key/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import {
  bearer,
  errorResponse,
  ErrorCode,
  json,
  methodNotAllowed,
} from "./http.js";
import { checkBuildGate, tighterMin, tighterMax } from "./gate.js";
import { Catalog } from "@polaris-key/catalog";
import {
  buildDoc,
  computeETag,
  signDoc,
  validatePayload,
} from "./configDoc.js";
import {
  getKey,
  getLicense,
  getActiveSchema,
  touchKey,
  setMachineStatus,
  setMachineReported,
  upsertMachine,
} from "./repo.js";
import { hashKey } from "./crypto.js";
import { deleteTokenRecord } from "./kv.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";
import {
  authorizeMachine,
  docProfile,
  resolveEffective,
  rotateMachineToken,
  validateMachineToken,
} from "./licenseCore.js";

function machineMetadata(req: Request): {
  userAgent: string | null;
  platform: string | null;
  arch: string | null;
  appVersion: string | null;
  sdkName: string | null;
  sdkVersion: string | null;
} {
  return {
    userAgent: req.headers.get("user-agent"),
    platform: req.headers.get(HEADER_PLATFORM),
    arch: req.headers.get(HEADER_ARCH),
    appVersion: req.headers.get(HEADER_VERSION),
    sdkName: req.headers.get(HEADER_SDK_NAME),
    sdkVersion: req.headers.get(HEADER_SDK_VERSION),
  };
}

function boundedReport(input: unknown): Record<string, unknown> {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const key of [
    "sdk",
    "sdkVersion",
    "appVersion",
    "platform",
    "arch",
    "gate",
    "config",
    "entitlements",
    "timestamp",
  ]) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return out;
}

/** POST /<product>/enroll — exchange a license key for a per-machine token. */
export async function handleEnroll(
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
      { bucket: "enroll", id: clientIp(req), limit: 30, windowSec: 60 },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many enrollment attempts");
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
  const authorized = await authorizeMachine(
    env,
    db,
    product,
    license,
    deviceId,
    now,
    machineMetadata(req),
  );
  if ("error" in authorized) {
    if (authorized.error === "unauthorized")
      return errorResponse(401, ErrorCode.Unauthorized);
    return errorResponse(403, ErrorCode.MachineLimit, "device limit reached", {
      limit: authorized.limit,
      machineCount: authorized.machineCount,
    });
  }
  await touchKey(db, product.slug, keyHash, now);

  return json({
    token: authorized.token,
    schemaVersion: product.schemaVersion,
  });
}

/** POST /<product>/token — replace the current token for an already-authorized machine.
 *  The compatibility route name remains, but this is no longer a device-id-only re-mint:
 *  callers must present the current bearer token and the matching device id. */
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
  const valid = await validateMachineToken(
    env,
    db,
    product,
    currentToken,
    now,
    {
      deviceId,
    },
  );
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);

  const token = await rotateMachineToken(env, db, product, valid, now);
  return json({ token, schemaVersion: product.schemaVersion });
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
  const valid = await validateMachineToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  const meta = machineMetadata(req);
  await upsertMachine(db, {
    ...valid.machine,
    last_seen: now,
    ua: meta.userAgent ?? valid.machine.ua,
    platform: meta.platform ?? valid.machine.platform ?? null,
    arch: meta.arch ?? valid.machine.arch ?? null,
    app_version: meta.appVersion ?? valid.machine.app_version ?? null,
    sdk_name: meta.sdkName ?? valid.machine.sdk_name ?? null,
    sdk_version: meta.sdkVersion ?? valid.machine.sdk_version ?? null,
  });

  let payload = await resolveEffective(
    db,
    product.slug,
    valid.license,
    valid.machine,
    now,
    { tighterMin, tighterMax },
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
      // An unparseable catalog is non-fatal here — fall back to the unfiltered payload.
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
    deviceId: valid.machine.machine_id,
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

/** POST /<product>/config/report — store the device's reported (non-secret) snapshot. */
export async function handleReport(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const token = bearer(req);
  const valid = await validateMachineToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  const len = req.headers.get("content-length");
  if (len && Number(len) > 16 * 1024)
    return errorResponse(413, "body_too_large", "report body too large");
  const rawText = await req.text();
  if (rawText.length > 16 * 1024)
    return errorResponse(413, "body_too_large", "report body too large");
  let snapshot: unknown;
  try {
    snapshot = rawText.trim() ? (JSON.parse(rawText) as unknown) : {};
  } catch {
    return errorResponse(400, ErrorCode.BadRequest, "invalid body");
  }
  await setMachineReported(
    db,
    product.slug,
    valid.machine.machine_id,
    JSON.stringify(boundedReport(snapshot)),
    now,
  );
  return json({ ok: true });
}

/** POST /<product>/deauthorize — self-deauthorize the bearer token's machine. */
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
  const valid = await validateMachineToken(
    env,
    db,
    product,
    token,
    Math.floor(Date.now() / 1000),
  );
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);
  await setMachineStatus(
    db,
    product.slug,
    valid.machine.machine_id,
    "deauthorized",
  );
  await deleteTokenRecord(env, product.slug, tokenHash);
  return json({ ok: true });
}
