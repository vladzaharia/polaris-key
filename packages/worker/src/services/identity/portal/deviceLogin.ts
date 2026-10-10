/**
 * "Sign in with another device" (PX-W14; docs/design/PORTAL.md §4.23, §4.24, §10.2 G29).
 *
 * A device that is not signed in asks to be; a device that is approves it:
 *
 *   POST /api/device-login/start             pre-auth: a request with a short code and a QR code
 *   GET  /api/device-login/<id>              pre-auth: the new device polls; on approval the
 *                                            answer signs it in (sets the session cookie)
 *   POST /api/device-login/lookup  {code}    signed in: what is asking (device, place, when), so
 *                                            the approver sees it BEFORE deciding
 *   POST /api/device-login/approve {code, decision: "approve" | "deny"}
 *                                            signed in, CSRF: the explicit decision
 *
 * Every artefact lives in the atomic single-use store (I-02, `core/singleUse.ts`):
 *
 *   - `device-login`, by the poll handle's peppered hash: the request record, JSON
 *     `{ status, createdAt, expiresAt, binding, device, location, … }`;
 *   - `device-login-code`, by the normalised code's peppered hash: the request record's address.
 *     Written `ifAbsent`, so two live requests never share a code.
 *
 * The rules the THREAT-MODEL row holds this module to (phishing is the threat: an attacker starts
 * a request on THEIR device and talks the victim into approving it):
 *
 *   - Short expiry: `DEVICE_LOGIN_TTL_SECONDS` (5 minutes), enforced by the store itself.
 *   - Single use: approving or denying CONSUMES the code (one atomic step, so two approvals racing
 *     on one code cannot both land), then moves the record out of `pending` with a compare-and-set;
 *     the poll that sees `approved` consumes the record before minting the session, so exactly one
 *     poll is ever signed in.
 *   - Never auto-approve: nothing approves a request except `approve` with an explicit
 *     `decision: "approve"`; `lookup` only reads. A missing or unknown decision is a `422`.
 *   - The place is shown: the request records the requesting device's coarse location (Cloudflare's
 *     edge geolocation: city, region, country) and browser and OS; `lookup` returns them and the
 *     approver's own country, and the notice email names them.
 *   - Step-up for a new location (`approvalNeedsStepUp`): when the requesting device's country is
 *     not the approver's (or either is unknown), approval needs a sign-in no older than
 *     `STEP_UP_MAX_AGE_SECONDS` (the account links' step-up), else `401 step_up_required` and the
 *     code stays live (the refusal is audited, `portal.device_login.step_up_required`).
 *   - An approval is not a sign-in: the approved device's session carries the APPROVER's sign-in
 *     time as its own (`deviceSessionAuthenticatedAt`), never `now`, so it is never fresh enough
 *     to pass a step-up its approver could not have passed.
 *   - Bound to the browser that started it: `start` sets an `HttpOnly` binding cookie whose hash
 *     the record holds, and a poll without it is answered exactly like an expired request, so a
 *     poll handle that leaks (a log line, a shoulder) signs nobody in.
 *
 * Every decision is audited (`portal.device_login.approve` / `.deny`); an approval also sends the
 * "A new device signed in" security notice to every verified address on the account.
 */

import {
  PLATFORM_LABELS,
  detectPlatform,
} from "../../../core/platformDetect.js";
import { qrSvg } from "../../../core/qr.js";
import { constantTimeEqual } from "../../../platform/compare.js";
import { hashKey } from "../../../platform/crypto.js";
import { parseJsonColumn } from "../../../platform/json.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { ErrorCode } from "../../../core/errors.js";
import {
  formatUserCode,
  generateUserCode,
  normalizeUserCode,
} from "../oidc.js";
import { STEP_UP_MAX_AGE_SECONDS, isFresh } from "../accounts/links.js";
import {
  getPortalAccount,
  portalAuthCapabilities,
  portalAudit,
  syncAccountLicenseLinks,
} from "./repo.js";
import { portalSessionAuthenticatedAt, type PortalSession } from "./session.js";
import { startAccountSession } from "./accountSessions.js";
import { sendSecurityNotice } from "./email.js";
import { displayValue, newDeviceSignInNotice } from "./notices.js";
import { appSecurityHeaders as portalSecurityHeaders } from "../../../core/securityHeaders.js";

/** How long a request (and its code) lives: the "Works for 4:52" countdown starts here. */
export const DEVICE_LOGIN_TTL_SECONDS = 5 * 60;
/** How often the new device should poll. */
export const DEVICE_LOGIN_POLL_INTERVAL_SECONDS = 3;
/** Starts per client network per window (pre-auth, so it fails closed). */
export const DEVICE_LOGIN_START_LIMIT = 10;
export const DEVICE_LOGIN_START_WINDOW_SECONDS = 10 * 60;
/** Polls per client network per minute: a 3-second poll uses 20. */
export const DEVICE_LOGIN_POLL_LIMIT = 60;
/** Lookups and decisions per account per minute (any client): the guess bound on codes. */
export const DEVICE_LOGIN_APPROVE_LIMIT = 10;

/** The binding cookie `start` sets and the poll requires. `__Host-` for the reason the session
 *  cookie is (R1-08); `Strict`, because nothing cross-site ever needs to send it. */
export const DEVICE_LOGIN_COOKIE = "__Host-pkey_device_login";

/** The poll handle's shape: `dl_` and 43 base64url characters (32 random bytes). */
const POLL_ID = /^dl_[A-Za-z0-9_-]{43}$/;
/** Retries on a code collision among live codes (each is ~1e-10) before giving up. */
const CODE_ATTEMPTS = 5;

type DeviceLoginStatus = "pending" | "approved" | "denied";

/** The stored request. */
export interface DeviceLoginRecord {
  status: DeviceLoginStatus;
  /** Unix seconds. */
  createdAt: number;
  expiresAt: number;
  /** The binding cookie's peppered hash. */
  binding: string;
  /** The display code, `WDJB-MJHT`, for the approver's screen. */
  code: string;
  device: { label: string; browser: string | null; os: string | null };
  location: DeviceLoginLocation;
  /** Set by a decision. */
  accountId?: string;
  decidedAt?: number;
  /** Set by an approval: when the APPROVER last signed in (`portalSessionAuthenticatedAt`). The
   *  new device's session carries it as its own sign-in time, so an approval never mints a
   *  session fresher than the proof behind it (see `deviceSessionAuthenticatedAt`). */
  approverAuthenticatedAt?: number;
}

/** A coarse place from Cloudflare's edge geolocation; every field may be unknown. */
export interface DeviceLoginLocation {
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2, upper-case. */
  country: string | null;
  /** "Lisbon, Portugal", or null when nothing is known. */
  label: string | null;
}

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), {
    status,
    headers: portalSecurityHeaders(headers),
  });
}

function err(status: number, code: string, message?: string): Response {
  return json({ error: code, ...(message ? { message } : {}) }, status);
}

/** Every "this request is not (or no longer) there" answer, whatever the reason. */
function expired(): Response {
  return err(410, "expired", "this request has expired");
}

async function recordRef(env: Env, pollId: string): Promise<ArtefactRef> {
  return artefactRef(
    "device-login",
    await hashKey(pollId, env.KEY_HASH_PEPPER),
  );
}

/** Exported for tests that inspect the code index. */
export async function deviceLoginCodeRef(
  env: Env,
  normalisedCode: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "device-login-code",
    await hashKey(normalisedCode, env.KEY_HASH_PEPPER),
  );
}

function parseRecord(raw: string | null): DeviceLoginRecord | null {
  const rec = parseJsonColumn<DeviceLoginRecord>(raw);
  return rec && typeof rec === "object" && typeof rec.status === "string"
    ? rec
    : null;
}

// ── What is asking ──────────────────────────────────────────────────────────────────────────

/** The browser by name, from the User-Agent; null when it is not one we name. */
export function browserName(ua: string): string | null {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "Firefox";
  if (/\bChrome\/|\bCriOS\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Safari";
  return null;
}

/** "Chrome on macOS", "Safari on iPhone and iPad", "A browser on Windows", "A device". */
export function requestingDevice(
  headers: Headers,
): DeviceLoginRecord["device"] {
  const ua = (headers.get("user-agent") ?? "").slice(0, 512);
  const browser = browserName(ua);
  const platform = detectPlatform(headers).platform;
  const os = platform ? PLATFORM_LABELS[platform] : null;
  const label = browser
    ? os
      ? `${browser} on ${os}`
      : browser
    : os
      ? `A browser on ${os}`
      : "A device";
  return { label, browser, os };
}

function countryName(code: string): string {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * The request's coarse place: Cloudflare's `request.cf` (city, region, country), falling back to
 * the `cf-ipcountry` header the edge sets. Both are written by Cloudflare, never the client. Each
 * value is cleaned (`displayValue`) because it reaches an email subject's neighbourhood.
 */
export function requestLocation(req: Request): DeviceLoginLocation {
  const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? displayValue(v, "") || null : null;
  const rawCountry =
    str(cf.country) ?? str(req.headers.get("cf-ipcountry")) ?? null;
  // `XX` (unknown) and `T1` (Tor) are Cloudflare's "no country".
  const country =
    rawCountry &&
    /^[A-Za-z]{2}$/.test(rawCountry) &&
    !/^(XX|T1)$/i.test(rawCountry)
      ? rawCountry.toUpperCase()
      : null;
  const city = str(cf.city);
  const region = str(cf.region);
  const parts = [city, country ? countryName(country) : region].filter(
    (p): p is string => Boolean(p),
  );
  return {
    city,
    region,
    country,
    label: parts.length ? parts.join(", ") : null,
  };
}

/**
 * Whether approving needs a step-up: the requesting device's country is not the approver's, or
 * either is unknown (fail closed). The one place "new location" is decided, so a richer notion
 * (the countries the account has signed in from, once I-15 keeps server-side sessions) replaces
 * this function and nothing else.
 */
export function isNewLocation(
  requested: DeviceLoginLocation,
  approver: DeviceLoginLocation,
): boolean {
  return (
    !requested.country ||
    !approver.country ||
    requested.country !== approver.country
  );
}

/**
 * The sign-in time the approved device's session carries: the approver's, never `now`. A device
 * signed in by approval has proved nothing itself, so its session must not count as a fresh
 * sign-in; if it did, a same-country approval (no step-up) would yield a session that passes
 * every step-up for five minutes: approving a second device from anywhere, adding a sign-in
 * method to the account. A record without the field (written before this rule) is dated past
 * the step-up window, failing closed.
 */
export function deviceSessionAuthenticatedAt(
  record: Pick<DeviceLoginRecord, "approverAuthenticatedAt">,
  now: number,
): number {
  const at = record.approverAuthenticatedAt;
  return typeof at === "number" && Number.isFinite(at)
    ? Math.min(at, now)
    : now - STEP_UP_MAX_AGE_SECONDS - 1;
}

function approvalNeedsStepUp(
  session: PortalSession,
  newLocation: boolean,
  now: number,
): boolean {
  if (!newLocation) return false;
  return !isFresh(
    {
      accountId: session.accountId,
      authenticatedAt: portalSessionAuthenticatedAt(session),
    },
    now,
  );
}

// ── Cookies ─────────────────────────────────────────────────────────────────────────────────

function bindingCookie(secret: string): string {
  return [
    `${DEVICE_LOGIN_COOKIE}=${secret}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${DEVICE_LOGIN_TTL_SECONDS}`,
  ].join("; ");
}

function clearBindingCookie(): string {
  return [
    `${DEVICE_LOGIN_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Max-Age=0",
  ].join("; ");
}

/** The binding cookie's value; null when absent or duplicated (fail closed, as R1-08). */
function readBindingCookie(header: string | null): string | null {
  if (!header) return null;
  const values = new Set<string>();
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === DEVICE_LOGIN_COOKIE) values.add(rest.join("="));
  }
  if (values.size !== 1) return null;
  return values.values().next().value ?? null;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

/** `POST /api/device-login/start` — pre-auth. */
export async function handleDeviceLoginStart(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalDeviceLoginStart",
      id: clientNetwork(req),
      limit: DEVICE_LOGIN_START_LIMIT,
      windowSec: DEVICE_LOGIN_START_WINDOW_SECONDS,
    },
    now,
  );
  if (!ok) return err(429, "rate_limited", "too many attempts");
  if (!(await portalAuthCapabilities(db)).portalEnabled)
    return err(404, "auth_method_disabled", "the portal is off");

  const pollId = `dl_${randomToken(32)}`;
  const binding = randomToken(32);
  const ref = await recordRef(env, pollId);

  let code: string | null = null;
  for (let i = 0; i < CODE_ATTEMPTS && code === null; i++) {
    const candidate = generateUserCode();
    if (
      await putArtefact(
        env,
        await deviceLoginCodeRef(env, candidate),
        ref.id,
        DEVICE_LOGIN_TTL_SECONDS,
        { ifAbsent: true },
      )
    )
      code = candidate;
  }
  if (code === null) return err(503, "unavailable", "try again");

  const display = formatUserCode(code);
  const record: DeviceLoginRecord = {
    status: "pending",
    createdAt: now,
    expiresAt: now + DEVICE_LOGIN_TTL_SECONDS,
    binding: await hashKey(binding, env.KEY_HASH_PEPPER),
    code: display,
    device: requestingDevice(req.headers),
    location: requestLocation(req),
  };
  await putArtefact(env, ref, JSON.stringify(record), DEVICE_LOGIN_TTL_SECONDS);

  const approveUrl = `${new URL(req.url).origin}/#/account/approve?code=${display}`;
  const svg = qrSvg(approveUrl, "QR code to approve this sign-in");
  return json(
    {
      id: pollId,
      code: display,
      // A `data:` URI, because the portal's CSP is `img-src 'self' data:`: an `<img src>` away.
      qr: svg ? `data:image/svg+xml;base64,${btoa(svg)}` : null,
      approveUrl,
      expiresIn: DEVICE_LOGIN_TTL_SECONDS,
      interval: DEVICE_LOGIN_POLL_INTERVAL_SECONDS,
    },
    201,
    [bindingCookie(binding)],
  );
}

/** `GET /api/device-login/<id>` — pre-auth, from the browser that started it. */
export async function handleDeviceLoginPoll(
  req: Request,
  env: Env,
  db: Db,
  pollId: string,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return err(405, "method_not_allowed");
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalDeviceLoginPoll",
      id: clientNetwork(req),
      limit: DEVICE_LOGIN_POLL_LIMIT,
      windowSec: 60,
    },
    now,
  );
  if (!ok) return err(429, "rate_limited", "too many attempts");
  if (!POLL_ID.test(pollId)) return expired();
  const cookie = readBindingCookie(req.headers.get("cookie"));
  if (!cookie) return expired();
  const ref = await recordRef(env, pollId);
  const record = parseRecord(await getArtefact(env, ref));
  if (
    !record ||
    record.expiresAt <= now ||
    !constantTimeEqual(
      record.binding,
      await hashKey(cookie, env.KEY_HASH_PEPPER),
    )
  )
    return expired();

  if (record.status === "pending") {
    return json({
      status: "pending",
      expiresIn: Math.max(0, record.expiresAt - now),
      interval: DEVICE_LOGIN_POLL_INTERVAL_SECONDS,
    });
  }
  // A decision: take the record (at most one poll ever gets it) and answer it.
  const taken = parseRecord(await consumeArtefact(env, ref));
  if (!taken || taken.status !== record.status) return expired();
  if (taken.status === "denied")
    return json({ status: "denied" }, 200, [clearBindingCookie()]);

  const account = taken.accountId
    ? await getPortalAccount(db, taken.accountId, now)
    : null;
  if (!account || account.status !== "active")
    return err(403, "account_disabled", "this account cannot sign in");
  await syncAccountLicenseLinks(db, account.id, now);
  // One account session like every other sign-in (I-07), carrying the approver's sign-in time.
  const { cookie: sessionCookie } = await startAccountSession(
    env,
    db,
    {
      account,
      req,
      amr: ["device"],
      authenticatedAt: deviceSessionAuthenticatedAt(taken, now),
    },
    now,
  );
  await portalAudit(db, {
    accountId: account.id,
    action: "portal.login.device",
    summary: `Signed in on ${taken.device.label} by approval from another device`,
    now,
  });
  return json({ status: "approved" }, 200, [
    sessionCookie,
    clearBindingCookie(),
  ]);
}

/** A signed-in route's resolved request, or the response that refuses it. */
async function findByCode(
  env: Env,
  body: Record<string, unknown>,
  now: number,
): Promise<
  | { codeRef: ArtefactRef; ref: ArtefactRef; record: DeviceLoginRecord }
  | Response
> {
  const code = normalizeUserCode(
    typeof body.code === "string" ? body.code : null,
  );
  if (!code) return err(422, ErrorCode.BadRequest, "enter the 8-letter code");
  const codeRef = await deviceLoginCodeRef(env, code);
  const id = await getArtefact(env, codeRef);
  if (!id) return expired();
  const ref = artefactRef("device-login", id);
  const record = parseRecord(await getArtefact(env, ref));
  if (!record || record.status !== "pending" || record.expiresAt <= now)
    return expired();
  return { codeRef, ref, record };
}

function requestView(
  record: DeviceLoginRecord,
  approver: DeviceLoginLocation,
  session: PortalSession,
  now: number,
): Record<string, unknown> {
  const newLocation = isNewLocation(record.location, approver);
  return {
    code: record.code,
    device: record.device,
    location: record.location,
    requestedAt: record.createdAt,
    expiresIn: Math.max(0, record.expiresAt - now),
    approverCountry: approver.country,
    newLocation,
    stepUpRequired: approvalNeedsStepUp(session, newLocation, now),
  };
}

/** `POST /api/device-login/lookup {code}` — signed in; reads only. */
export async function handleDeviceLoginLookup(
  req: Request,
  env: Env,
  session: PortalSession,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const found = await findByCode(env, body, now);
  if (found instanceof Response) return found;
  return json({
    request: requestView(found.record, requestLocation(req), session, now),
  });
}

/** `POST /api/device-login/approve {code, decision}` — signed in, CSRF. */
export async function handleDeviceLoginApprove(
  req: Request,
  env: Env,
  db: Db,
  session: PortalSession,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return err(405, "method_not_allowed");
  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny")
    return err(422, ErrorCode.BadRequest, 'choose "approve" or "deny"');
  const found = await findByCode(env, body, now);
  if (found instanceof Response) return found;
  const { codeRef, ref, record } = found;

  // Checked BEFORE the code is spent, so a step-up answer leaves it live for the retry.
  if (decision === "approve") {
    const newLocation = isNewLocation(record.location, requestLocation(req));
    if (approvalNeedsStepUp(session, newLocation, now)) {
      // Not a decision (the code stays live), but worth a row: during a phishing attempt this is
      // the trace of someone being talked into approving a device elsewhere.
      await portalAudit(db, {
        accountId: session.accountId,
        action: "portal.device_login.step_up_required",
        targetKind: "device_login",
        targetId: ref.id.slice(0, 16),
        summary: `Asked to sign in again before approving ${record.device.label}${record.location.label ? ` near ${record.location.label}` : ""}`,
        now,
      });
      return json(
        {
          error: "step_up_required",
          message: "sign in again to approve a device in another place",
          maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
        },
        // 401 with `error: "step_up_required"`, as the portal's other step-up (G7, "Get a new
        // key", selfService.ts) answers: one shape for the portal client to recognise.
        401,
      );
    }
  }

  // Single use: of any number of racing decisions on this code, one takes it.
  if ((await consumeArtefact(env, codeRef)) !== ref.id) return expired();
  const status: DeviceLoginStatus =
    decision === "approve" ? "approved" : "denied";
  const moved = await updateArtefact(env, ref, {
    expect: { status: "pending" },
    set: {
      status,
      accountId: session.accountId,
      decidedAt: now,
      ...(decision === "approve"
        ? { approverAuthenticatedAt: portalSessionAuthenticatedAt(session) }
        : {}),
    },
  });
  if (!moved.ok) return expired();

  const where = record.location.label ? ` near ${record.location.label}` : "";
  await portalAudit(db, {
    accountId: session.accountId,
    action:
      decision === "approve"
        ? "portal.device_login.approve"
        : "portal.device_login.deny",
    targetKind: "device_login",
    targetId: ref.id.slice(0, 16),
    summary: `${decision === "approve" ? "Approved" : "Denied"} a sign-in on ${record.device.label}${where}`,
    now,
  });
  if (decision === "approve") {
    await sendSecurityNotice(
      env,
      db,
      session.accountId,
      session.email,
      newDeviceSignInNotice({
        deviceLabel: record.device.label,
        location: record.location.label,
        at: now,
        origin: new URL(req.url).origin,
      }),
      now,
    );
  }
  return json({ ok: true, status });
}
