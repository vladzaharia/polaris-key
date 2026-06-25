/// <reference types="@cloudflare/workers-types" />

// The licensing hot path: enroll (key -> token), token re-acquire, /config (token ->
// signed doc), report, deauthorize. Product isolation is structural — every repo/KV call
// is product-scoped, the signing key is the product's, and the doc carries aud = product.

import { HEADER_CHANNEL, HEADER_VERSION } from "@polaris-key/protocol";
import { HEADER_DEVICE } from "@polaris-key/protocol";
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
    { userAgent: req.headers.get("user-agent") },
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
  let snapshot: unknown;
  try {
    snapshot = await req.json();
  } catch {
    return errorResponse(400, ErrorCode.BadRequest, "invalid body");
  }
  await setMachineReported(
    db,
    product.slug,
    valid.machine.machine_id,
    JSON.stringify(snapshot ?? {}),
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
