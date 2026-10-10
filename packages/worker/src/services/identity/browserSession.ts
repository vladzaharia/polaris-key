/// <reference types="@cloudflare/workers-types" />

/**
 * The browser session — Identity's cookie-bearing principal (design spec §2.1, D-14).
 *
 * A page signs in (OIDC, or by presenting a licence key), gets a `pkey_<slug>_session` cookie
 * bound to a `browser:<licenseId>` device row, and reads its settings from
 * `GET /<p>/identity/session`.
 *
 * ── WHY THE RESPONSE SHAPE DOES NOT CHANGE HERE ─────────────────────────────────────────────
 *
 * That document is still the FUSED v2 shape (`buildDoc`, `./doc.ts`): one payload carrying
 * config, secrets and entitlements, rather than the two signed documents wire v3 split it into.
 * The identity carve moves the URL and nothing else. The React SDK migrates against whatever
 * `/identity/session` serves, in a sibling P5 wave, and changing the path and the body in the
 * same commit would leave that wave unable to tell a route regression from a shape regression.
 *
 * Note what this surface therefore keeps: the build gate (spec §3.2 names `/identity/session`
 * beside `/license/document` as an enforcement point) and the catalog prune, both applied in
 * exactly the order and with exactly the fail-closed behaviour they had before the move.
 */

import { isSameOriginRequest } from "../../core/browserRequestGuard.js";
import { constantTimeEqual } from "../../core/platform.js";
import { HEADER_CHANNEL, HEADER_VERSION } from "@polaris-key/protocol/core";
import { Catalog } from "@polaris-key/catalog";
import {
  bearer,
  deleteTokenRecord,
  hashKey,
  mintOpaqueToken,
  randomId,
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
import { clientNetwork, rateLimitOk } from "../../core/rateLimit.js";
import {
  getActiveSchema,
  getKey,
  getLicense,
  setDeviceStatus,
  touchKey,
  type LicenseRow,
} from "../../core/data.js";
import { deviceMetadata } from "../../core/devices.js";
import { buildManageUrl } from "../../core/manageUrl.js";
import {
  countKeyEntries,
  keyEntryGate,
  keyEntryLimitResponse,
  licenseOwnedResponse,
} from "../../core/keyEntries.js";
import { logRefusal } from "../../core/refusals.js";
// The seat decision, the licence-gated device check and the fused merge all live in
// `core/authz.ts`: Core's `validateDeviceToken` answers only "is this token a live device",
// because a config-only product has devices with no licence at all (D-08), and the
// licence-usability half is shared with License, Release and Update rather than owned by any
// of them. This surface therefore behaves byte-identically to before the wire-v3 split.
import {
  authorizeDevice,
  docProfile,
  requireLicensedDevice,
  resolveEffective,
} from "../../core/authz.js";
import { validatePayload } from "../../core/payload.js";
import { clearDeviceSubjects } from "../../core/subjectHooks.js";
import { checkBuildGate, tighterMax, tighterMin } from "../../core/gate.js";
import type { SettingsRegistry } from "../../core/settings/registry.js";
import { graceClampFor } from "../../core/graceClamp.js";
import { licenseOfflineDays } from "../../core/entitlements.js";
import { buildDoc, type FusedSessionDoc } from "./doc.js";
import { resolveAccount } from "./accounts/repo.js";
import { platformSubjectAccountRefused } from "./accounts/platformMigration.js";
import { readBodyJson } from "../../core/cappedBody.js";

/** The platform-IdP subject a `provider: platform` sign-in verified (the OIDC return path). */
export interface BrowserSessionSubject {
  /** The platform issuer the ID token was verified against. */
  issuer: string;
  sub: string;
}

interface BrowserSessionRecord {
  token: string;
  csrf: string;
  licenseId: string;
  deviceId: string;
  createdAt: number;
  /** The platform-IdP subject that signed in, when a `provider: platform` sign-in opened this
   *  session (the OIDC return path); absent on a key session and on a custom issuer's. While it
   *  is set, {@link loadBrowserSession} runs N9's check on it at every read, so the session ends
   *  once ANY account that holds the subject's method can no longer sign in: one the subject
   *  already belonged to, one it was linked to after the session opened, or one its method moved
   *  to. */
  subject?: BrowserSessionSubject;
  /** The Polaris Key account the subject belonged to when the session opened; absent for a
   *  subject with no account. Kept beside `subject` for erasure: erasing an account deletes its
   *  methods (`account_links`), after which the subject resolves no account and N9's check
   *  alone would let the session live on. While it is set, the session also ends once this
   *  account is disabled, being deleted or gone (the N9 residual). */
  accountId?: string;
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
  // A duplicate may be a planted copy (cookie tossing), so it fails closed; a
  // malformed percent-encoding is "no cookie", not a 500.
  const values = new Set<string>();
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) values.add(v.join("="));
  }
  if (values.size !== 1) return null;
  try {
    return decodeURIComponent(values.values().next().value ?? "") || null;
  } catch {
    return null;
  }
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
  /** PX-W9 (WIRE-CONTRACT-V4 §12.2): a browser KEY session on an Identity product records its
   *  key entry with the seat claim. The OIDC return path never passes it. `subject` and
   *  `accountId` are the other way round: only the OIDC return path passes them, for a
   *  `provider: platform` sign-in (see `BrowserSessionRecord`). */
  opts: {
    keyEntry?: { surface: "browser" };
    subject?: BrowserSessionSubject | null;
    accountId?: string | null;
  } = {},
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
  const sessionToken = mintOpaqueToken();
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
    // I-05: a browser key entry (plans/I-04.md §2.2) never sets the account binding.
    boundBy: "key",
    ...(opts.keyEntry ? { keyEntry: opts.keyEntry } : {}),
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
    ...(opts.subject
      ? { subject: { issuer: opts.subject.issuer, sub: opts.subject.sub } }
      : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
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

/**
 * The session behind a request's cookie, or `null`.
 *
 * Exported for `registration.ts`, which is the arm of `POST /<p>/devices/register` that a
 * `requires-identity` product answers with. Deliberately a READ: it resolves the cookie to the
 * stored record and nothing else — deciding whether that record still authorizes anything is
 * the caller's, because "may this browser register a device" and "may this browser read its own
 * settings" are different questions with different answers under D-08.
 *
 * A corrupt stored value is treated exactly like a missing one, the same rule `oidc.ts`'s
 * `parseFlowRecord` applies to flow records (R11-06). Every caller already has a well-defined
 * answer for "there is no session here", and a truncated or garbled KV value is
 * indistinguishable from that for any purpose they have — where an uncaught `SyntaxError` would
 * escape as a 500. That mattered less when only `GET /session` read this; it matters now that
 * the registration policy does, because a 500 there is a mint path failing open-endedly rather
 * than refusing.
 *
 * The one thing it does besides reading: a session a `provider: platform` sign-in opened lives
 * only as long as its subject could sign in again (N9). Every read runs N9's check on the
 * recorded subject (`record.subject`: whichever account holds its method now, so a subject
 * linked to an account after the session opened, or whose method moved to another account, is
 * covered), and checks the account it belonged to at sign-in (`record.accountId`, which also
 * catches erasure, since erasing an account deletes its methods). Either one disabled, being
 * deleted or gone (an absorbed account follows its join as `signIn` does) ends the session: the
 * record is deleted and the answer is "no session", so the page reads signed out, a
 * `requires-identity` product refuses to register a device on it, and sign-out has nothing to
 * end. The browser device's seat and token are left alone: they belong to the licence, not the
 * account (the N9 residual's decision).
 *
 * A D1 error while checking answers "no session" too, for that request only: the record is
 * kept, since the failure says nothing about the account, and the next read checks again. The
 * same never-a-500 rule as a corrupt record, and it fails closed.
 */
export async function loadBrowserSession(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<{ tokenHash: string; record: BrowserSessionRecord } | null> {
  const token = readCookie(req, cookieName(product.slug));
  if (!token) return null;
  const tokenHash = await hashKey(token, env.KEY_HASH_PEPPER);
  const key = sessionKey(product.slug, tokenHash);
  const raw = await env.HOT.get(key);
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as BrowserSessionRecord;
  let ended: boolean;
  try {
    ended = await sessionAccountRefused(db, record, now);
  } catch {
    return null; // D1 unavailable: signed out for now, the record kept (see above)
  }
  if (ended) {
    await env.HOT.delete(key);
    return null;
  }
  return { tokenHash, record };
}

/**
 * Whether a browser session's sign-in can no longer stand (N9): its platform subject belongs to
 * an account that can no longer sign in, or the account it signed in as is disabled, being
 * deleted or gone. `false` for a session with neither (a key session, a custom issuer's, a
 * subject that never had an account). Throws on a D1 error; the caller decides.
 */
async function sessionAccountRefused(
  db: Db,
  record: BrowserSessionRecord,
  now: number,
): Promise<boolean> {
  const subject = record.subject;
  if (
    subject &&
    typeof subject.issuer === "string" &&
    typeof subject.sub === "string" &&
    (await platformSubjectAccountRefused(db, subject.issuer, subject.sub, now))
  )
    return true;
  if (typeof record.accountId === "string") {
    const account = await resolveAccount(db, record.accountId, now);
    if (!account || account.status !== "active") return true;
  }
  return false;
}

async function browserDoc(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  record: BrowserSessionRecord,
  now: number,
  settings: SettingsRegistry | undefined,
): Promise<
  | { ok: true; doc: FusedSessionDoc }
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
  const valid = await requireLicensedDevice(
    env,
    db,
    product,
    record.token,
    now,
    { deviceId: record.deviceId },
  );
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
      const catalog = new Catalog(JSON.parse(schemaRow.catalog_json));
      payload = validatePayload(payload, catalog);
      // A `kind: "config"` entry flagged `secret: true` is a secret too; page JS
      // never sees it.
      payload = {
        ...payload,
        config: Object.fromEntries(
          Object.entries(payload.config).filter(
            ([k]) => catalog.entryByKey(k)?.secret !== true,
          ),
        ),
      };
    } catch {
      // FAIL CLOSED, matching `/config/document` (500 `catalog_unavailable`).
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

  const maxOfflineDays = licenseOfflineDays(valid.license, product);
  return {
    ok: true,
    doc: buildDoc({
      schemaVersion: product.schemaVersion,
      aud: product.slug,
      licenseId: valid.license.id,
      deviceId: valid.device.device_id,
      now,
      maxOfflineDays,
      // LX-07 (S-19 G9): the fused document grants the licence too, so it is clamped the same way.
      clampGraceTo: await graceClampFor(
        { env, db, registry: settings },
        product.slug,
        valid.license,
        now,
        maxOfflineDays,
      ),
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
  /** ST-04's settings registry (`ServiceContext.settings`): LX-07's grace clamp is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();
  const session = await loadBrowserSession(req, env, db, product, now);
  if (!session) return json({ authenticated: false, doc: null });
  const result = await browserDoc(
    req,
    env,
    db,
    product,
    session.record,
    now,
    settings,
  );
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
 * POST /<product>/identity/session/license — exchange a license KEY for a browser session cookie.
 *
 * This is a credential-exchange endpoint that takes an attacker-suppliable secret and reports
 * whether it is valid, so it is an online oracle for guessing license keys — and it had no
 * rate limit at all, while `/license/activate` (which does exactly the same key→credential exchange
 * for native clients) is capped at 30/min. Same shape, same budget, same fail-closed policy.
 */
export async function handleBrowserSessionLicense(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
  /** ST-04's settings registry (`ServiceContext.settings`): the key-entry limit is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  // A cross-site page must not be able to open a session for a key it holds.
  if (!isSameOriginRequest(req))
    return errorResponse(403, "forbidden", "cross-site request refused");
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "browserSessionLicense",
        id: clientNetwork(req),
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
    body = (await readBodyJson(req)) as { key?: unknown };
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
  // PX-W9 (WIRE-CONTRACT-V4 §12.2): a key entry on the `browser` surface. This route exists only
  // while Identity is on, so the gate always counts here. The browser device is
  // `browser:<licenseId>`, so it counts at most once per enrolment.
  const deviceId = `browser:${license.id}`;
  const gate = await keyEntryGate(
    { env, db, registry: settings },
    product,
    license,
    deviceId,
    now,
  );
  if (gate.kind === "refuse" || gate.kind === "owned") {
    const meta = deviceMetadata(req);
    await logRefusal(db, {
      product: product.slug,
      licenseId: license.id,
      deviceId,
      reason: gate.kind === "owned" ? "license_owned" : "key_entry_limit",
      at: now,
      platform: meta.platform,
      arch: meta.arch,
      userAgent: meta.userAgent ?? "browser-session",
    });
    // I-09 (§12.2 step 3): a licence in an account is reached by signing in, never by its key.
    if (gate.kind === "owned") return licenseOwnedResponse(env, req, product);
    return keyEntryLimitResponse(env, db, req, product, gate.keyEntries);
  }
  const session = await createBrowserSession(
    env,
    db,
    product,
    license,
    now,
    req,
    gate.kind === "admit" ? { keyEntry: { surface: "browser" } } : {},
  );
  if (!session.ok) {
    // PX-W8: the browser key entry's seat refusal carries the refusal link. The OIDC return
    // path (oidc.ts) does not: sign-in seat refusals are LX-18's (plans/PX-W8.md Q5).
    const manageUrl =
      session.code === ErrorCode.DeviceLimit
        ? await buildManageUrl(env, db, req, product, {
            kind: "device_limit",
            license,
          })
        : undefined;
    return errorResponse(session.status, session.code, session.message, {
      ...session.extra,
      ...(manageUrl !== undefined ? { manageUrl } : {}),
    });
  }
  await touchKey(db, product.slug, keyHash, now);
  return json(
    {
      ok: true,
      // §12.2 rule 5: the count after this entry.
      ...(gate.kind === "admit"
        ? {
            keyEntries: {
              used: await countKeyEntries(db, product.slug, license.id),
              limit: gate.keyEntries.limit,
            },
          }
        : {}),
    },
    { status: 201, headers: { "set-cookie": session.cookie } },
  );
}

export async function handleBrowserLogout(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();
  const session = await loadBrowserSession(req, env, db, product, now);
  if (session) {
    const csrf = req.headers.get("x-csrf-token");
    if (!csrf || !constantTimeEqual(csrf, session.record.csrf))
      return errorResponse(403, ErrorCode.Forbidden, "csrf mismatch");
    const deviceTokenHash = await hashKey(
      session.record.token,
      env.KEY_HASH_PEPPER,
    );
    // U-02: sign-out runs Core's clearing hook, so the device loses its Cloud Sync principal
    // with its session (S-17 §5.8 item 2), whatever deauthorizing the row does afterwards.
    await clearDeviceSubjects(
      db,
      env,
      {
        kind: "device",
        product: product.slug,
        deviceId: session.record.deviceId,
      },
      "signout",
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
