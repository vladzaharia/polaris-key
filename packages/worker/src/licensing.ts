/// <reference types="@cloudflare/workers-types" />

// The licensing hot path: enroll (key -> token), token re-acquire, /config (token ->
// signed doc), report, deauthorize. Product isolation is structural — every repo/KV call
// is product-scoped, the signing key is the product's, and the doc carries aud = product.

import {
  HEADER_CHANNEL,
  HEADER_VERSION,
  type DocProfile,
  type ManagedPayload,
} from "@polaris-key/protocol";
import { HEADER_DEVICE } from "@polaris-key/protocol";
import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { bearer, errorResponse, ErrorCode, json, methodNotAllowed } from "./http.js";
import { hashKey, mintToken } from "./crypto.js";
import { checkBuildGate } from "./gate.js";
import { buildDoc, computeETag, signDoc } from "./configDoc.js";
import { mergePayloads } from "./merge.js";
import {
  getKey,
  getLicense,
  getMachine,
  getProfile,
  getTier,
  countActiveMachines,
  touchKey,
  upsertMachine,
  setMachineStatus,
  setMachineReported,
  type LicenseRow,
  type MachineRow,
} from "./repo.js";
import {
  deleteTokenRecord,
  getTokenRecord,
  putTokenRecord,
} from "./kv.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";

function docProfile(license: LicenseRow): DocProfile {
  const name = license.name ?? "";
  return {
    name,
    firstName: name.split(" ")[0] ?? "",
    email: license.email ?? "",
    enrolledAt: license.enrolled_at,
  };
}

/** Effective managed payload: tier(profile) -> license(profile) -> license overrides -> machine. */
async function resolveEffective(
  db: Db,
  product: string,
  license: LicenseRow,
  machine?: MachineRow | null,
): Promise<ManagedPayload> {
  let tierProfileJson: string | null = null;
  if (license.tier_id) {
    const tier = await getTier(db, product, license.tier_id);
    if (tier?.profile_id) {
      const p = await getProfile(db, product, tier.profile_id);
      tierProfileJson = p?.payload_json ?? null;
    }
  }
  let licProfileJson: string | null = null;
  if (license.profile_id) {
    const p = await getProfile(db, product, license.profile_id);
    licProfileJson = p?.payload_json ?? null;
  }
  return mergePayloads(tierProfileJson, licProfileJson, license.overrides_json, machine?.overrides_json ?? null);
}

function resolveMachineLimit(payload: ManagedPayload, fallback: number): number {
  const e = payload.entitlements["machineLimit"];
  return e && typeof e.value === "number" ? e.value : fallback;
}

function licenseUsable(license: LicenseRow | null, now: number): license is LicenseRow {
  if (!license || license.status !== "active") return false;
  if (license.expires_at !== null && now > license.expires_at) return false;
  return true;
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
  if (!(await rateLimitOk(env, product.slug, { bucket: "enroll", id: clientIp(req), limit: 30, windowSec: 60 }, now))) {
    return errorResponse(429, "rate_limited", "too many enrollment attempts");
  }
  const key = bearer(req);
  if (!key) return errorResponse(401, ErrorCode.Unauthorized);
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId) return errorResponse(400, ErrorCode.BadRequest, "missing device id");

  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active") return errorResponse(401, ErrorCode.Unauthorized);

  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!licenseUsable(license, now)) return errorResponse(401, ErrorCode.Unauthorized);

  const existing = await getMachine(db, product.slug, deviceId);
  const isNewAuthorization = !existing || existing.status !== "authorized";
  if (isNewAuthorization) {
    const eff = await resolveEffective(db, product.slug, license);
    const limit = resolveMachineLimit(eff, product.defaultMachineLimit);
    if (limit > 0) {
      const count = await countActiveMachines(db, product.slug, license.id);
      if (count >= limit) {
        return errorResponse(403, ErrorCode.MachineLimit, "device limit reached", {
          limit,
          machineCount: count,
        });
      }
    }
  }

  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);

  // Drop the machine's previous token record (if any) so it can't keep authenticating.
  if (existing?.token_hash && existing.token_hash !== tokenHash) {
    await deleteTokenRecord(env, product.slug, existing.token_hash);
  }

  await upsertMachine(db, {
    product: product.slug,
    machine_id: deviceId,
    license_id: license.id,
    status: "authorized",
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    ua: req.headers.get("user-agent"),
    label: existing?.label ?? null,
    overrides_json: existing?.overrides_json ?? null,
    reported_json: existing?.reported_json ?? null,
    token_hash: tokenHash,
  });
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    machineId: deviceId,
    licenseId: license.id,
  });
  await touchKey(db, product.slug, keyHash, now);

  return json({ token, schemaVersion: product.schemaVersion });
}

/** POST /<product>/token — re-acquire a token for an already-authorized machine (after a
 *  local wipe). Bound to the device id; rate-limited at the edge (Phase 7). */
export async function handleToken(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  if (!(await rateLimitOk(env, product.slug, { bucket: "token", id: clientIp(req), limit: 30, windowSec: 60 }, now))) {
    return errorResponse(429, "rate_limited", "too many token requests");
  }
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId) return errorResponse(400, ErrorCode.BadRequest, "missing device id");
  const machine = await getMachine(db, product.slug, deviceId);
  if (!machine || machine.status !== "authorized") return errorResponse(401, ErrorCode.Unauthorized);
  const license = await getLicense(db, product.slug, machine.license_id);
  if (!licenseUsable(license, now)) return errorResponse(401, ErrorCode.Unauthorized);

  const token = mintToken();
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  if (machine.token_hash && machine.token_hash !== tokenHash) {
    await deleteTokenRecord(env, product.slug, machine.token_hash);
  }
  await upsertMachine(db, { ...machine, last_seen: now, token_hash: tokenHash });
  await putTokenRecord(env, product.slug, tokenHash, {
    product: product.slug,
    machineId: deviceId,
    licenseId: license.id,
  });
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
  if (!token) return errorResponse(401, ErrorCode.Unauthorized);
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const rec = await getTokenRecord(env, product.slug, tokenHash);
  if (!rec) return errorResponse(401, ErrorCode.Unauthorized);

  const license = await getLicense(db, product.slug, rec.licenseId);
  if (!licenseUsable(license, now)) return errorResponse(401, ErrorCode.Unauthorized);
  const machine = await getMachine(db, product.slug, rec.machineId);
  if (!machine || machine.status !== "authorized") return errorResponse(401, ErrorCode.Unauthorized);

  const payload = await resolveEffective(db, product.slug, license, machine);

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

  const maxOfflineDays = license.max_offline_days ?? product.defaultMaxOfflineDays;
  const doc = buildDoc({
    schemaVersion: product.schemaVersion,
    aud: product.slug,
    licenseId: license.id,
    deviceId: rec.machineId,
    now,
    maxOfflineDays,
    profile: docProfile(license),
    payload,
  });
  const etag = await computeETag(doc);
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const jws = await signDoc(doc, product.signingKeyPem, product.signingKid);
  return new Response(jws, {
    status: 200,
    headers: { "content-type": "application/jwt", etag, "cache-control": "no-store" },
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
  if (!token) return errorResponse(401, ErrorCode.Unauthorized);
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const rec = await getTokenRecord(env, product.slug, tokenHash);
  if (!rec) return errorResponse(401, ErrorCode.Unauthorized);
  let snapshot: unknown;
  try {
    snapshot = await req.json();
  } catch {
    return errorResponse(400, ErrorCode.BadRequest, "invalid body");
  }
  await setMachineReported(db, product.slug, rec.machineId, JSON.stringify(snapshot ?? {}), now);
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
  const rec = await getTokenRecord(env, product.slug, tokenHash);
  if (!rec) return errorResponse(401, ErrorCode.Unauthorized);
  await setMachineStatus(db, product.slug, rec.machineId, "deauthorized");
  await deleteTokenRecord(env, product.slug, tokenHash);
  return json({ ok: true });
}
