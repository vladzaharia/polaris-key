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
import { hashKey, mintToken, randomId } from "./crypto.js";
import {
  getActiveSchema,
  getKey,
  getLicense,
  setMachineStatus,
  touchKey,
  type LicenseRow,
} from "./repo.js";
import { deleteTokenRecord } from "./kv.js";
import {
  authorizeMachine,
  docProfile,
  resolveEffective,
  validateMachineToken,
} from "./licenseCore.js";
import { buildDoc, validatePayload } from "./configDoc.js";
import { checkBuildGate, tighterMax, tighterMin } from "./gate.js";

interface BrowserSessionRecord {
  token: string;
  csrf: string;
  licenseId: string;
  machineId: string;
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
  const machineId = `browser:${license.id}`;
  const auth = await authorizeMachine(
    env,
    db,
    product,
    license,
    machineId,
    now,
    {
      userAgent: "browser-session",
    },
  );
  if ("error" in auth) {
    if (auth.error === "machine_limit") {
      return {
        ok: false,
        status: 403,
        code: ErrorCode.MachineLimit,
        message: "device limit reached",
        extra: { limit: auth.limit, machineCount: auth.machineCount },
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
    machineId,
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
      blocked?: {
        reason: string;
        allowedRange?: { min?: string; max?: string };
      };
    }
> {
  const valid = await validateMachineToken(
    env,
    db,
    product,
    record.token,
    now,
    {
      deviceId: record.machineId,
    },
  );
  if ("error" in valid) return { ok: false };

  let payload = await resolveEffective(
    db,
    product.slug,
    valid.license,
    valid.machine,
    now,
    { tighterMin, tighterMax },
  );
  const schemaRow = await getActiveSchema(db, product.slug);
  if (schemaRow) {
    try {
      payload = validatePayload(
        payload,
        new Catalog(JSON.parse(schemaRow.catalog_json)),
      );
    } catch {
      // If the catalog row is malformed, keep behavior aligned with /config and fail open
      // for filtering while still relying on the signed/config gate below.
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
      deviceId: valid.machine.machine_id,
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
  if (!result.ok && !result.blocked)
    return json({ authenticated: false, doc: null });
  return json({
    authenticated: true,
    doc: result.ok ? result.doc : null,
    ...(result.ok ? {} : { blocked: result.blocked }),
    csrfToken: session.record.csrf,
  });
}

export async function handleBrowserSessionLicense(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
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
  const session = await createBrowserSession(env, db, product, license, now);
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
    const machineTokenHash = await hashKey(
      session.record.token,
      env.KEY_HASH_PEPPER,
    );
    await setMachineStatus(
      db,
      product.slug,
      session.record.machineId,
      "deauthorized",
    );
    await deleteTokenRecord(env, product.slug, machineTokenHash);
    await env.HOT.delete(sessionKey(product.slug, session.tokenHash));
  }
  return json(
    { ok: true },
    { headers: { "set-cookie": clearCookieHeader(product.slug) } },
  );
}
