/**
 * The Google Play side of the commerce bridge (P6-01; notes/E2 §E4).
 *
 * **Push authentication.** Real-time developer notifications arrive as Pub/Sub push requests whose
 * `Authorization: Bearer` is a Google-signed OIDC JWT. `verifyPushJwt` checks it against Google's
 * JWKS (`https://www.googleapis.com/oauth2/v3/certs`, cached in KV for an hour and refetched at
 * most once a minute for an unknown `kid`), issuer `https://accounts.google.com` (or the bare
 * `accounts.google.com` Google also issues), the operator's configured audience, `email` equal to
 * the push subscription's service account and `email_verified: true`. Anything else is 401 before
 * the body is believed.
 *
 * **The API is truth.** The push body only names a purchase token; every decision comes from
 * `purchases.products.get` through P5-03's `GoogleApiClient` (fixed origin, redirect-free, capped,
 * 429 backoff) with the `google-service-account` credential PINNED to the commerce settings'
 * package (P5-02f's pin): grant only `purchaseState` 0 (PURCHASED), never 2 (PENDING); a
 * licence-tester purchase (`purchaseType` 0) only where the operator accepts test purchases;
 * `obfuscatedExternalAccountId` must be a licence's binding.
 *
 * **Acknowledgement.** A granted purchase is acknowledged once (`…:acknowledge`), within Google's
 * three days: right after the grant, else on the next connector tick (`commerce/recheck.ts`). The
 * purchase's `detail_json.acknowledged` and Play's own `acknowledgementState` both stop a second
 * call.
 *
 * **Voids.** A `voidedPurchaseNotification` revokes; the daily Voided Purchases poll is the
 * backstop for a lost push.
 */

import {
  createLocalJWKSet,
  decodeProtectedHeader,
  errors as joseErrors,
  jwtVerify,
  type JSONWebKeySet,
} from "jose";
import { parseJsonObject } from "../../../platform/json.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../core/outletCredentials.js";
import {
  googleAccessToken,
  platformGoogleAccessToken,
} from "../../../core/outletTokens.js";
import { parsePlatformCredentialHandle } from "../../../core/platformCredentials.js";
import { resolvePlatformStoreSetting } from "../../../core/platformStoreSettings.js";
import { platformFallback } from "../connectors/platformFallback.js";
import { readCappedText } from "../../../core/readCapped.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  ANDROID_PUBLISHER_SCOPE,
  GoogleApiClient,
  PlayError,
} from "../connectors/play/client.js";
import type { PlaySettings } from "./settings.js";
import { normaliseBinding, type VerifiedPurchase } from "./state.js";
import { StoreUnavailable } from "./http.js";

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

const PURCHASE_TOKEN = /^[A-Za-z0-9._-]{1,1024}$/;
const SKU = /^[a-z0-9][a-z0-9._]{0,139}$/;

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

export function isPurchaseToken(v: unknown): v is string {
  return typeof v === "string" && PURCHASE_TOKEN.test(v);
}

export function isPlaySku(v: unknown): v is string {
  return typeof v === "string" && SKU.test(v);
}

// ── the Android Publisher purchases API ──────────────────────────────────────────────────────

/** The `google-service-account` credential pinned to `packageName` (lowest id), or null. */
export async function playCredential(
  env: Env,
  db: Db,
  product: string,
  packageName: string,
): Promise<string | null> {
  const own = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === "google-service-account",
  );
  if (own.length > 0)
    return (
      own.find((c) => checkOutletCredentialPin(c, packageName).ok)?.id ?? null
    );
  // A-16: no key of the product's own — the platform service account, for the pinned package.
  const f = await platformFallback(
    env,
    db,
    product,
    "google-play.service-account",
    packageName,
  );
  return f.ok ? f.handle : null;
}

/** The product's Play settings with the platform's RTDN push identity filled in where the
 *  product leaves it unset (A-16). A product's own value always wins. */
export async function effectivePlaySettings(
  env: Env,
  db: Db,
  settings: PlaySettings,
): Promise<PlaySettings> {
  const pushAudience =
    settings.pushAudience ??
    (await resolvePlatformStoreSetting(env, db, "google-play.pushAudience"))
      ?.value ??
    null;
  const pushServiceAccount =
    settings.pushServiceAccount ??
    (
      await resolvePlatformStoreSetting(
        env,
        db,
        "google-play.pushServiceAccount",
      )
    )?.value ??
    null;
  return { ...settings, pushAudience, pushServiceAccount };
}

export interface PlayContext {
  env: Env;
  db: Db;
  product: string;
  now: number;
  settings: PlaySettings;
  credentialId: string;
}

export function playPurchasesClient(
  ctx: PlayContext,
  use: string,
): GoogleApiClient {
  return new GoogleApiClient({
    origin: ANDROID_PUBLISHER_ORIGIN,
    packageName: ctx.settings.packageName,
    token: () =>
      parsePlatformCredentialHandle(ctx.credentialId)
        ? platformGoogleAccessToken(
            ctx.env,
            ctx.db,
            { product: ctx.product, pin: ctx.settings.packageName },
            [ANDROID_PUBLISHER_SCOPE],
            use,
            ctx.now,
          )
        : googleAccessToken(
            ctx.env,
            ctx.db,
            ctx.product,
            ctx.credentialId,
            [ANDROID_PUBLISHER_SCOPE],
            use,
            ctx.now,
          ),
  });
}

/** Why a Play purchase was refused. */
export type PlayRejection =
  | "unknown_purchase"
  | "test_purchase"
  | "invalid_purchase";

export class PlayRejected extends Error {
  constructor(readonly reason: PlayRejection) {
    super(`play: ${reason}`);
    this.name = "PlayRejected";
  }
}

/** The fields of `purchases.products.get` the bridge reads. */
export interface PlayProductPurchase {
  purchaseState: number;
  acknowledgementState: number;
  purchaseType: number | null;
  obfuscatedExternalAccountId: string | null;
  orderId: string | null;
}

/** Wrap a Play client call: a 404/410/400 means "no such purchase", the rest is transient. */
async function playCall<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlayError) {
      if (e.status === 400 || e.status === 404 || e.status === 410)
        throw new PlayRejected("unknown_purchase");
      throw new StoreUnavailable(label, e.status);
    }
    throw e;
  }
}

/** `purchases.products.get` for one (product id, token). Throws `PlayRejected` /
 *  `StoreUnavailable`. */
export async function getProductPurchase(
  api: GoogleApiClient,
  sku: string,
  token: string,
): Promise<PlayProductPurchase> {
  const doc = await playCall("play purchases.products.get", () =>
    api.request(
      "GET",
      ["purchases", "products", sku, "tokens", token],
      "purchases.products.get",
    ),
  );
  if (!doc || typeof doc.purchaseState !== "number")
    throw new PlayRejected("invalid_purchase");
  return {
    purchaseState: doc.purchaseState,
    acknowledgementState:
      typeof doc.acknowledgementState === "number"
        ? doc.acknowledgementState
        : 0,
    purchaseType:
      typeof doc.purchaseType === "number" ? doc.purchaseType : null,
    obfuscatedExternalAccountId:
      typeof doc.obfuscatedExternalAccountId === "string"
        ? doc.obfuscatedExternalAccountId
        : null,
    orderId: typeof doc.orderId === "string" ? doc.orderId.slice(0, 128) : null,
  };
}

/** `purchases.products.acknowledge`. Throws `StoreUnavailable` (or `PlayRejected`). */
export async function acknowledgePurchase(
  api: GoogleApiClient,
  sku: string,
  token: string,
): Promise<void> {
  await playCall("play purchases.products.acknowledge", () =>
    api.request(
      "POST",
      ["purchases", "products", sku, "tokens", token],
      "purchases.products.acknowledge",
      { body: {}, custom: "acknowledge" },
    ),
  );
}

/** One purchase as the store-agnostic record. Throws `PlayRejected` for a test purchase the
 *  operator does not accept. */
export function playPurchase(
  settings: PlaySettings,
  sku: string,
  token: string,
  p: PlayProductPurchase,
): VerifiedPurchase {
  const test = p.purchaseType === 0;
  if (test && !settings.acceptTestPurchases)
    throw new PlayRejected("test_purchase");
  return {
    store: "play",
    purchaseKey: token,
    storeProductId: sku,
    environment: test ? "play-test" : "Production",
    // 0 PURCHASED grants; 2 PENDING records and grants nothing; 1 CANCELED revokes.
    state:
      p.purchaseState === 0
        ? "active"
        : p.purchaseState === 2
          ? "pending"
          : "revoked",
    binding: normaliseBinding(p.obfuscatedExternalAccountId),
    detail: {
      sku,
      purchaseToken: token,
      orderId: p.orderId,
      ...(p.acknowledgementState === 1 ? { acknowledged: true } : {}),
    },
  };
}

/** A voided purchase from the Voided Purchases API. */
export interface VoidedPurchase {
  purchaseToken: string;
  voidedTimeMillis: number;
}

/**
 * `purchases.voidedpurchases.list` since `startTimeMillis` (one-time products), every page up to
 * `maxPages`. Throws `StoreUnavailable`.
 */
export async function listVoidedPurchases(
  api: GoogleApiClient,
  startTimeMillis: number,
  maxPages = 10,
): Promise<VoidedPurchase[]> {
  const out: VoidedPurchase[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const query: Record<string, string> = {
      startTime: String(startTimeMillis),
      maxResults: "1000",
    };
    if (pageToken) query.token = pageToken;
    const doc = await playCall("play voidedpurchases.list", () =>
      api.request(
        "GET",
        ["purchases", "voidedpurchases"],
        "purchases.voidedpurchases.list",
        {
          query,
        },
      ),
    );
    const list = Array.isArray(doc?.voidedPurchases) ? doc.voidedPurchases : [];
    for (const v of list) {
      const o = v as Record<string, unknown>;
      if (isPurchaseToken(o.purchaseToken))
        out.push({
          purchaseToken: o.purchaseToken,
          voidedTimeMillis: Number(o.voidedTimeMillis) || 0,
        });
    }
    const next = (doc?.tokenPagination as Record<string, unknown> | undefined)
      ?.nextPageToken;
    if (typeof next !== "string" || next === "") break;
    pageToken = next;
  }
  return out;
}
