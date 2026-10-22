/**
 * Google Play real-time developer notifications: authenticating the Pub/Sub push (`verifyPushJwt`)
 * and decoding its body (`decodeRtdn`). Split from `purchases.ts` by P0-27.4 (CM-29 D3); no
 * behaviour change. The push body only names a purchase token; the purchases API is the truth.
 */

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { parseJsonObject } from "../../../../platform/json.js";
import type { Env } from "../../../../platform/env.js";
import { readCappedText } from "../../../../core/readCapped.js";
import type { PlaySettings } from "../../settings.js";

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_PUSH_ISSUERS = [
  "https://accounts.google.com",
  "accounts.google.com",
];
const JWKS_KV_KEY = "commerce:google-jwks";
const JWKS_CACHE_SECONDS = 60 * 60;
const JWKS_REFETCH_MIN_SECONDS = 60;
const MAX_JWKS_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 60;

interface CachedJwks {
  keys: JSONWebKeySet["keys"];
  fetchedAt: number;
}

async function fetchGoogleJwks(): Promise<JSONWebKeySet> {
  const res = await fetch(GOOGLE_JWKS_URL, {
    headers: { accept: "application/json" },
    redirect: "manual",
  });
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`jwks: HTTP ${res.status}`);
  }
  const text = await readCappedText(
    res,
    MAX_JWKS_BYTES,
    () => new Error("jwks too large"),
  );
  const set = JSON.parse(text) as JSONWebKeySet;
  if (!set || !Array.isArray(set.keys)) throw new Error("malformed jwks");
  return set;
}

async function googleJwksFor(
  env: Env,
  kid: string,
  now: number,
): Promise<CachedJwks | null> {
  let cached: CachedJwks | null = null;
  try {
    const raw = await env.HOT.get(JWKS_KV_KEY);
    const v = raw ? (JSON.parse(raw) as CachedJwks) : null;
    cached =
      v && Array.isArray(v.keys) && typeof v.fetchedAt === "number" ? v : null;
  } catch {
    cached = null;
  }
  const fresh = cached !== null && now - cached.fetchedAt < JWKS_CACHE_SECONDS;
  const hasKid = (c: CachedJwks | null) =>
    c !== null && c.keys.some((k) => k.kid === kid);
  if (fresh && hasKid(cached)) return cached;
  if (
    cached === null ||
    !fresh ||
    now - cached.fetchedAt >= JWKS_REFETCH_MIN_SECONDS
  ) {
    try {
      const set = await fetchGoogleJwks();
      cached = { keys: set.keys, fetchedAt: now };
      await env.HOT.put(JWKS_KV_KEY, JSON.stringify(cached), {
        expirationTtl: 24 * 60 * 60,
      });
    } catch {
      /* keep what we had; an unknown kid is the answer */
    }
  }
  return cached;
}

/** Why a push request is refused (all answered 401). */
export type PushRejection =
  | "no_token"
  | "bad_token"
  | "unknown_key"
  | "wrong_issuer"
  | "wrong_audience"
  | "wrong_account"
  | "unverified_email"
  | "expired";

/** Verify a Pub/Sub push request's OIDC token (see the header). */
export async function verifyPushJwt(
  env: Env,
  authorization: string | null,
  settings: PlaySettings,
  now: number,
): Promise<{ ok: true } | { ok: false; reason: PushRejection }> {
  // Fail closed when no push identity is configured (neither the product's nor the platform's).
  if (settings.pushAudience === null)
    return { ok: false, reason: "wrong_audience" };
  if (settings.pushServiceAccount === null)
    return { ok: false, reason: "wrong_account" };
  const m = authorization?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/);
  if (!m) return { ok: false, reason: "no_token" };
  const token = m[1]!;
  let header: { alg?: string; kid?: string };
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return { ok: false, reason: "bad_token" };
  }
  if (
    header.alg !== "RS256" ||
    typeof header.kid !== "string" ||
    header.kid === ""
  )
    return { ok: false, reason: "bad_token" };
  const jwks = await googleJwksFor(env, header.kid, now);
  if (!jwks || !jwks.keys.some((k) => k.kid === header.kid))
    return { ok: false, reason: "unknown_key" };
  try {
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet({ keys: jwks.keys }),
      {
        issuer: GOOGLE_PUSH_ISSUERS,
        audience: settings.pushAudience as string,
        algorithms: ["RS256"],
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: new Date(now * 1000),
        requiredClaims: ["exp", "iat"],
      },
    );
    if (payload.email !== settings.pushServiceAccount)
      return { ok: false, reason: "wrong_account" };
    if (payload.email_verified !== true)
      return { ok: false, reason: "unverified_email" };
    return { ok: true };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired)
      return { ok: false, reason: "expired" };
    if (e instanceof joseErrors.JWTClaimValidationFailed)
      return {
        ok: false,
        reason:
          e.claim === "aud"
            ? "wrong_audience"
            : e.claim === "iss"
              ? "wrong_issuer"
              : "bad_token",
      };
    return { ok: false, reason: "bad_token" };
  }
}

// ── the push body ────────────────────────────────────────────────────────────────────────────

export interface RtdnMessage {
  messageId: string;
  packageName: string;
  /** `oneTimeProductNotification` (1 PURCHASED, 2 CANCELED). */
  oneTime: {
    notificationType: number;
    purchaseToken: string;
    sku: string;
  } | null;
  voided: { purchaseToken: string; productType: number | null } | null;
  test: boolean;
  /** The decoded `message.data` (stored raw). */
  raw: string;
}

export const PURCHASE_TOKEN = /^[A-Za-z0-9._-]{1,1024}$/;
export const SKU = /^[a-z0-9][a-z0-9._]{0,139}$/;

/** Decode a Pub/Sub push body into an RTDN message, or null when it is not one. */
export function decodeRtdn(body: Record<string, unknown>): RtdnMessage | null {
  const message = body.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    return null;
  const msg = message as Record<string, unknown>;
  const messageId = msg.messageId ?? msg.message_id;
  if (
    typeof messageId !== "string" ||
    !/^[0-9A-Za-z_-]{1,128}$/.test(messageId)
  )
    return null;
  if (typeof msg.data !== "string" || msg.data.length > 64 * 1024) return null;
  let raw: string;
  try {
    const bin = atob(msg.data);
    raw = new TextDecoder().decode(
      Uint8Array.from(bin, (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
  const data = parseJsonObject(raw);
  if (!data || typeof data.packageName !== "string") return null;
  const obj = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const one = obj(data.oneTimeProductNotification);
  const voided = obj(data.voidedPurchaseNotification);
  return {
    messageId,
    packageName: data.packageName,
    oneTime:
      one &&
      typeof one.notificationType === "number" &&
      typeof one.purchaseToken === "string" &&
      PURCHASE_TOKEN.test(one.purchaseToken) &&
      typeof one.sku === "string" &&
      SKU.test(one.sku)
        ? {
            notificationType: one.notificationType,
            purchaseToken: one.purchaseToken,
            sku: one.sku,
          }
        : null,
    voided:
      voided &&
      typeof voided.purchaseToken === "string" &&
      PURCHASE_TOKEN.test(voided.purchaseToken)
        ? {
            purchaseToken: voided.purchaseToken,
            productType:
              typeof voided.productType === "number"
                ? voided.productType
                : null,
          }
        : null,
    test: obj(data.testNotification) !== null,
    raw,
  };
}

