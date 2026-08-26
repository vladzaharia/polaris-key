/// <reference types="@cloudflare/workers-types" />

import type { ManagedConfigDoc } from "@polaris-key/protocol";
import { HEADER_CHANNEL, HEADER_VERSION } from "@polaris-key/protocol";
import { Catalog } from "@polaris-key/catalog";
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
import { clientIp, rateLimitOk } from "./rateLimit.js";
import { hashKey, mintToken, randomId } from "./crypto.js";
import {
  getActiveSchema,
  getKey,
  getLicense,
  setDeviceStatus,
  touchKey,
  type LicenseRow,
} from "./repo.js";
import { deleteTokenRecord } from "./kv.js";
import { deviceMetadata } from "./licensing.js";
import {
  authorizeDevice,
  docProfile,
  resolveEffective,
  validateDeviceToken,
} from "./licenseCore.js";
import { buildDoc, validatePayload } from "./configDoc.js";
import { checkBuildGate, tighterMax, tighterMin } from "./gate.js";

interface BrowserSessionRecord {
  token: string;
  csrf: string;
  licenseId: string;
  deviceId: string;
  createdAt: number;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function cookieName(product: string): string {
  return `pkey_${product.replace(/-/g, "_")}_session`;
}

function sessionKey(product: string, hash: string): string {
  return `p:${product}:browser-session:${hash}`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setCookieHeader(product: string, token: string): string {
  return `${cookieName(product)}=${encodeURIComponent(token)}; Path=/${product}; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookieHeader(product: string): string {
  return `${cookieName(product)}=; Path=/${product}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export async function createBrowserSession(
  env: Env,
  db: Db,
  product: Product,
  license: LicenseRow,
  now: number,
  /** The originating request, so the browser device records the same platform/version
   *  metadata a native device does. Browsers send no hardware fingerprint by design — the
   *  headers are all the honest signal there is. */
  req?: Request,
): Promise<
  | { ok: true; cookie: string; record: BrowserSessionRecord }
  | {
      ok: false;
      status: number;
      code: string;
      message: string;
      extra?: Record<string, unknown>;
    }
> {
  const sessionToken = mintToken();
  const sessionHash = await hashKey(sessionToken, env.KEY_HASH_PEPPER);
  const deviceId = `browser:${license.id}`;
  const meta = req ? deviceMetadata(req) : null;
  const auth = await authorizeDevice(env, db, product, license, deviceId, now, {
    userAgent: meta?.userAgent ?? "browser-session",
    platform: meta?.platform ?? null,
    arch: meta?.arch ?? null,
    appVersion: meta?.appVersion ?? null,
    sdkName: meta?.sdkName ?? null,
    sdkVersion: meta?.sdkVersion ?? null,
  });
  if ("error" in auth) {
    if (auth.error === "device_limit") {
      return {
        ok: false,
        status: 403,
        code: ErrorCode.DeviceLimit,
        message: "device limit reached",
        extra: { limit: auth.limit, deviceCount: auth.deviceCount },
      };
    }
    return {
      ok: false,
      status: 401,
      code: ErrorCode.Unauthorized,
      message: "unauthorized",
    };
  }

  const record: BrowserSessionRecord = {
    token: auth.token,
    csrf: randomId("csrf"),
    licenseId: license.id,
    deviceId,
    createdAt: now,
  };
  await env.HOT.put(
    sessionKey(product.slug, sessionHash),
    JSON.stringify(record),
    { expirationTtl: SESSION_TTL_SECONDS },
  );
  return {
    ok: true,
    cookie: setCookieHeader(product.slug, sessionToken),
    record,
  };
}

async function loadBrowserSession(
  req: Request,
  env: Env,
  product: Product,
): Promise<{ tokenHash: string; record: BrowserSessionRecord } | null> {
  const token = readCookie(req, cookieName(product.slug));
  if (!token) return null;
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const raw = await env.HOT.get(sessionKey(product.slug, tokenHash));
  if (!raw) return null;
  return { tokenHash, record: JSON.parse(raw) as BrowserSessionRecord };
}

async function browserDoc(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  record: BrowserSessionRecord,
  now: number,
): Promise<
  | { ok: true; doc: ManagedConfigDoc }
  | {
      ok: false;
      /** The active catalog could not be used to validate the payload — see below. */
      catalogUnavailable?: true;
      blocked?: {
        reason: string;
        allowedRange?: { min?: string; max?: string };
      };
    }
> {
  const valid = await validateDeviceToken(env, db, product, record.token, now, {
    deviceId: record.deviceId,
  });
  if ("error" in valid) return { ok: false };

  let payload = await resolveEffective(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
    { tighterMin, tighterMax },
    // R12-02 — `env` opens the sealed managed secrets. `secrets` is stripped below, but a
    // `kind: "config"` entry flagged `secret: true` is sealed too and IS delivered here;
    // without this the envelope reaches validatePayload and is pruned as a schema violation.
    env,
  );
  const schemaRow = await getActiveSchema(db, product.slug);
  if (schemaRow) {
    try {
      payload = validatePayload(
        payload,
        new Catalog(JSON.parse(schemaRow.catalog_json)),
      );
    } catch {
      // FAIL CLOSED, matching `/config` (`licensing.ts` -> 500 `catalog_unavailable`).
      // `validatePayload` is what prunes unknown/invalid keys and stale overrides out of the
      // payload before it is signed; skipping it on a malformed catalog row delivered exactly
      // the payload the catalog exists to refuse. The previous comment claimed this was
      // "aligned with /config" — it was the opposite, and this surface is the one that hands
      // the doc to a browser. A broken catalog row is an operator problem, not a reason to
      // widen what a client receives.
      return { ok: false, catalogUnavailable: true };
    }
  }
  payload = { ...payload, secrets: {} };

  const gate = checkBuildGate({
    version: req.headers.get(HEADER_VERSION) ?? "0.0.0",
    channelHeader: req.headers.get(HEADER_CHANNEL) ?? undefined,
    entitlements: payload.entitlements,
    compatMin: product.compatMin,
    compatMax: product.compatMax,
  });
  if (!gate.ok) {
    if (!gate.reason) return { ok: false };
    return {
      ok: false,
      blocked: { reason: gate.reason, allowedRange: gate.allowedRange },
    };
  }

  return {
    ok: true,
    doc: buildDoc({
      schemaVersion: product.schemaVersion,
      aud: product.slug,
      licenseId: valid.license.id,
      deviceId: valid.device.device_id,
      now,
      maxOfflineDays:
        valid.license.max_offline_days ?? product.defaultMaxOfflineDays,
      profile: docProfile(valid.license),
      payload,
    }),
  };
}

export async function handleBrowserSession(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  const session = await loadBrowserSession(req, env, product);
  if (!session) return json({ authenticated: false, doc: null });
  const result = await browserDoc(req, env, db, product, session.record, now);
  if (!result.ok && result.catalogUnavailable) {
    return errorResponse(
      500,
      "catalog_unavailable",
      "active catalog could not validate the config payload",
    );
  }
  if (!result.ok && !result.blocked)
    return json({ authenticated: false, doc: null });
  return json({
    authenticated: true,
    doc: result.ok ? result.doc : null,
    ...(result.ok ? {} : { blocked: result.blocked }),
    csrfToken: session.record.csrf,
  });
}

/**
 * POST /<product>/session/license — exchange a license KEY for a browser session cookie.
 *
 * This is a credential-exchange endpoint that takes an attacker-suppliable secret and reports
 * whether it is valid, so it is an online oracle for guessing license keys — and it had no
 * rate limit at all, while `/activate` (which does exactly the same key→credential exchange
 * for native clients) is capped at 30/min. Same shape, same budget, same fail-closed policy.
 */
export async function handleBrowserSessionLicense(
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
      {
        bucket: "browserSessionLicense",
        id: clientIp(req),
        limit: 30,
        windowSec: 60,
      },
      now,
    ))
  ) {
    return errorResponse(429, "rate_limited", "too many session attempts");
  }
  let body: { key?: unknown };
  try {
    body = (await req.json()) as { key?: unknown };
  } catch {
    return errorResponse(400, ErrorCode.BadRequest, "invalid body");
  }
  const key = typeof body.key === "string" ? body.key : bearer(req);
  if (!key) return errorResponse(401, ErrorCode.Unauthorized);
  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active")
    return errorResponse(401, ErrorCode.Unauthorized);
  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!license) return errorResponse(401, ErrorCode.Unauthorized);
  const session = await createBrowserSession(
    env,
    db,
    product,
    license,
    now,
    req,
  );
  if (!session.ok)
    return errorResponse(
      session.status,
      session.code,
      session.message,
      session.extra,
    );
  await touchKey(db, product.slug, keyHash, now);
  return json(
    { ok: true },
    { status: 201, headers: { "set-cookie": session.cookie } },
  );
}

export async function handleBrowserLogout(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const session = await loadBrowserSession(req, env, product);
  if (session) {
    const csrf = req.headers.get("x-csrf-token");
    if (!csrf || csrf !== session.record.csrf)
      return errorResponse(403, ErrorCode.Forbidden, "csrf mismatch");
    const deviceTokenHash = await hashKey(
      session.record.token,
      env.KEY_HASH_PEPPER,
    );
    await setDeviceStatus(
      db,
      product.slug,
      session.record.deviceId,
      "deauthorized",
    );
    await deleteTokenRecord(env, product.slug, deviceTokenHash);
    await env.HOT.delete(sessionKey(product.slug, session.tokenHash));
  }
  return json(
    { ok: true },
    { headers: { "set-cookie": clearCookieHeader(product.slug) } },
  );
}
