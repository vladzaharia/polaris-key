/// <reference types="@cloudflare/workers-types" />

// The licensing hot path: activate (key -> token), token re-acquire, /config (token ->
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
  MAX_DEVICE_PROBES,
  type DeviceProbeResult,
} from "@plrs/protocol";
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
import { Catalog } from "@plrs/catalog";
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
  listDevicesByLicense,
  touchKey,
  setDeviceLabel,
  setDeviceStatus,
  setDeviceReported,
  upsertDevice,
  upsertDeviceFacts,
  type DeviceFactsRow,
  type DeviceRow,
  type LicenseRow,
} from "./repo.js";
import { parseFingerprint } from "./fingerprint.js";
import { hashKey } from "./crypto.js";
import { deleteTokenRecord } from "./kv.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";
import {
  authorizeDevice,
  docProfile,
  resolveEffective,
  rotateDeviceToken,
  validateDeviceToken,
  type AuthzError,
} from "./licenseCore.js";
import type { PresentedFingerprint } from "./fingerprint.js";

export function deviceMetadata(req: Request): {
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

// The report allowlist. Anything not named here is DROPPED SILENTLY, so a new client field
// that isn't added here vanishes without an error anywhere — add the key here and a test in
// licensingReport.test.ts together. The first six keys are the software-facts additions; the
// rest are the original v1 set and must stay.
const REPORT_KEYS = [
  "os",
  "hardware",
  "runtime",
  "locale",
  "timezone",
  "probes",
  "sdk",
  "sdkVersion",
  "appVersion",
  "platform",
  "arch",
  "gate",
  "config",
  "entitlements",
  "timestamp",
] as const;

/** Largest activation body we will read. A fingerprint is a handful of short digests; this is
 *  generous for that and far below the report cap. */
const MAX_ACTIVATE_BODY = 4 * 1024;

/**
 * Read the optional activation body's fingerprint.
 *
 * `/activate` carried no body before fingerprinting, so an absent, empty, oversized, or
 * unparseable body means "no fingerprint" and never an error — otherwise every already-shipped
 * client would start failing the moment this deployed. Whether a missing fingerprint is
 * actually acceptable is the tier's decision, enforced in `authorizeDevice`.
 */
export async function readFingerprint(
  req: Request,
): Promise<PresentedFingerprint | null> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_ACTIVATE_BODY) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (!raw.trim() || raw.length > MAX_ACTIVATE_BODY) return null;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return parseFingerprint(body.fingerprint);
  } catch {
    return null;
  }
}

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

function boundedReport(input: unknown): Record<string, unknown> {
  const src =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {};
  for (const key of REPORT_KEYS) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  // `probes` is the one open-ended map a client controls, so it gets its own bound on top of
  // the body-size cap: a truncated inventory must not be able to ride in under 16 KiB.
  const probes = out.probes;
  if (probes !== undefined) {
    out.probes = boundedProbes(probes);
  }
  return out;
}

function boundedProbes(input: unknown): Record<string, DeviceProbeResult> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, DeviceProbeResult> = {};
  for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_DEVICE_PROBES) break;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.present !== "boolean") continue;
    out[id.slice(0, 64)] = {
      present: entry.present,
      ...(typeof entry.version === "string"
        ? { version: entry.version.slice(0, 64) }
        : {}),
    };
  }
  return out;
}

/** Project the allowlisted report into the flat `device_facts` row shape. */
function factsFromReport(
  product: string,
  deviceId: string,
  report: Record<string, unknown>,
  now: number,
): DeviceFactsRow {
  const obj = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const str = (value: unknown): string | null =>
    typeof value === "string" ? value.slice(0, 128) : null;
  const int = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : null;

  const os = obj(report.os);
  const hardware = obj(report.hardware);
  const runtime = obj(report.runtime);
  return {
    product,
    device_id: deviceId,
    os_name: str(os.name),
    os_version: str(os.version),
    os_build: str(os.build),
    kernel: str(os.kernel),
    cpu_model: str(hardware.cpuModel),
    cpu_cores: int(hardware.cpuCores),
    ram_mb: int(hardware.ramMb),
    machine_model: str(hardware.machineModel),
    locale: str(report.locale),
    timezone: str(report.timezone),
    runtime_name: str(runtime.name),
    runtime_version: str(runtime.version),
    probes_json:
      report.probes === undefined ? null : JSON.stringify(report.probes),
    updated_at: now,
  };
}

export function shapeDevice(device: DeviceRow, currentDeviceId?: string) {
  return {
    id: device.device_id,
    licenseId: device.license_id,
    label: device.label,
    status: device.status,
    current: device.device_id === currentDeviceId,
    firstSeen: device.first_seen,
    lastSeen: device.last_seen,
    userAgent: device.ua,
    platform: device.platform ?? null,
    arch: device.arch ?? null,
    appVersion: device.app_version ?? null,
    sdkName: device.sdk_name ?? null,
    sdkVersion: device.sdk_version ?? null,
  };
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

/** GET/PATCH/DELETE /<product>/devices[/<id>] — self-service device management. */
export async function handleDevices(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  deviceId?: string,
): Promise<Response> {
  const token = bearer(req);
  const valid = await validateDeviceToken(env, db, product, token, now);
  if ("error" in valid) return errorResponse(401, ErrorCode.Unauthorized);

  const devices = await listDevicesByLicense(
    db,
    product.slug,
    valid.license.id,
  );
  if (req.method === "GET") {
    return json({
      currentDeviceId: valid.device.device_id,
      devices: devices.map((device) =>
        shapeDevice(device, valid.device.device_id),
      ),
    });
  }

  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");
  const target = devices.find((device) => device.device_id === deviceId);
  if (!target) return errorResponse(404, ErrorCode.NotFound);

  // R3-09: a device token authenticates ONE device, not the licence. Listing siblings is
  // legitimate self-service (the caller already paid for the seats), but MUTATING one is not:
  // any device could relabel or deauthorize every other install on the same licence — and the
  // DELETE arm purges the victim's fingerprint through `setDeviceStatus`, so the eviction is
  // not even recoverable by re-activating the same hardware. Cross-device management belongs
  // on the portal, which authenticates the licence OWNER and rate-limits the action.
  if (deviceId !== valid.device.device_id) {
    return errorResponse(
      403,
      ErrorCode.Forbidden,
      "a device token may only manage its own device",
    );
  }

  if (req.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return errorResponse(400, ErrorCode.BadRequest, "invalid json");
    }
    const label =
      typeof body.label === "string" && body.label.trim()
        ? body.label.trim().slice(0, 120)
        : null;
    await setDeviceLabel(db, product.slug, deviceId, label);
    return json({
      ok: true,
      device: { ...shapeDevice(target, valid.device.device_id), label },
    });
  }

  if (req.method === "DELETE") {
    await setDeviceStatus(db, product.slug, deviceId, "deauthorized");
    if (target.token_hash) {
      await deleteTokenRecord(env, product.slug, target.token_hash);
    }
    return json({ ok: true });
  }

  return methodNotAllowed();
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
  const valid = await validateDeviceToken(env, db, product, token, now);
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
  const report = boundedReport(snapshot);
  await setDeviceReported(
    db,
    product.slug,
    valid.device.device_id,
    JSON.stringify(report),
    now,
  );
  await upsertDeviceFacts(
    db,
    factsFromReport(product.slug, valid.device.device_id, report, now),
  );
  return json({ ok: true });
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
