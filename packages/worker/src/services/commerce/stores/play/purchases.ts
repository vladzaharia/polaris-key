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

import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../../../core/outletCredentials.js";
import {
  googleAccessToken,
  platformGoogleAccessToken,
} from "../../../../core/outletTokens.js";
import { parsePlatformCredentialHandle } from "../../../../core/platformCredentials.js";
import { resolvePlatformStoreSetting } from "../../../../core/platformStoreSettings.js";
import { platformFallback } from "../../../../core/stores/platformFallback.js";
import {
  ANDROID_PUBLISHER_ORIGIN,
  ANDROID_PUBLISHER_SCOPE,
  GoogleApiClient,
  PlayError,
} from "../../../../core/stores/play/client.js";
import type { PlaySettings } from "../../settings.js";
import {
  getPurchase,
  normaliseBinding,
  parseDetail,
  type RecordOutcome,
  type VerifiedPurchase,
} from "../../state.js";
import { StoreUnavailable } from "../../../../core/stores/http.js";
import { PURCHASE_TOKEN, SKU } from "./notifications.js";

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

/**
 * Acknowledge a granted Play purchase once (Google voids an unacknowledged purchase after three
 * days). Our record and Play's `acknowledgementState` both stop a second call; a failure is left
 * for the connector tick (`recheck.ts`) and never fails the grant.
 */
export async function acknowledgeOnce(
  pctx: PlayContext,
  api: ReturnType<typeof playPurchasesClient>,
  out: Extract<RecordOutcome, { ok: true }>,
  purchase: VerifiedPurchase,
): Promise<boolean> {
  if (out.state !== "active") return false;
  const row = await getPurchase(
    pctx.db,
    pctx.product,
    "play",
    out.purchaseKeyHash,
  );
  const detail = row ? parseDetail(row.detail_json) : {};
  if (detail.acknowledged === true) return false;
  try {
    await acknowledgePurchase(
      api,
      purchase.storeProductId,
      purchase.purchaseKey,
    );
  } catch (e) {
    if (e instanceof StoreUnavailable || e instanceof PlayRejected)
      return false;
    throw e;
  }
  await pctx.db.run(
    `UPDATE dist_purchases SET detail_json = ?
      WHERE product = ? AND store = 'play' AND purchase_key_hash = ?`,
    JSON.stringify({ ...detail, acknowledged: true, acknowledgedAt: pctx.now }),
    pctx.product,
    out.purchaseKeyHash,
  );
  return true;
}
