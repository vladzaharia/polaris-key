/// <reference types="@cloudflare/workers-types" />

/**
 * The commerce bridge's routes (P6-01): store purchases become licence flags, per deliverable.
 *
 *     GET  /<p>/distribution/commerce/binding     device token: the licence's opaque binding
 *                                                 UUID and the store products on sale
 *     POST /<p>/distribution/commerce/claim       device token: claim one store purchase
 *     POST /<p>/distribution/hooks/app-store      App Store Server Notifications V2 (Apple-signed)
 *     POST /<p>/distribution/hooks/play-rtdn      Play RTDN over Pub/Sub push (Google OIDC JWT)
 *
 * **Hidden unless set up.** Every route answers Core's not-found (`null`) when the product cannot
 * honour it: License off (no grant could land — the coherence rule "commerce needs License
 * enabled", `core/storeGrants.ts`), or, for a claim or a hook, the store not configured (no
 * settings block, or no credential pinned to the configured app). A product without commerce
 * looks exactly like one without Distribution.
 *
 * **Bind before buying.** `binding` creates the licence's binding UUID on first use; the SDK
 * passes it to the store at purchase time (Apple `appAccountToken`, Play `obfuscatedAccountId`)
 * or as the Steam web-API ticket's identity. A claim then grants only if the STORE's record names
 * the caller's own binding (`state.ts` `recordPurchase`). A device with no licence is told so
 * (`403 not_entitled`, reason `no_license`): the SDK enrols first; the bridge never creates a
 * licence.
 *
 * **Store notifications are processed inline** (verify, re-read the store, record), and a
 * transient store failure answers 503 so the STORE redelivers — App Store Server Notifications
 * retry a non-2xx for days, Pub/Sub push with backoff. That is a deliberate difference from the
 * ASC webhook's answer-then-work pattern, whose store does not retry. A redelivery is
 * deduplicated on the notification's own id (`notificationUUID`, the Pub/Sub `messageId`) in
 * `dist_connector_events`, and on the purchase key hash in `dist_purchases`.
 */

import type { ServiceContext } from "../../../core/registry.js";
import { errorResponse, json, wireError } from "../../../core/errors.js";
import { bearer } from "../../../core/platform.js";
import { licenseUsable, validateDeviceToken } from "../../../core/devices.js";
import { trustRefusal } from "../../../core/deviceTrust.js";
import type { DeviceRow } from "../../../core/data.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import { readCappedText } from "../../../core/readCapped.js";
import { isStore, type Store } from "../../../core/storeGrants.js";
import {
  eventSeen,
  recordEvent,
  type ConnectorEventOutcome,
} from "../connectors/state.js";
import {
  APPLE_ACTED_TYPES,
  AppleRejected,
  appStoreCredential,
  applePurchase,
  checkTransaction,
  environmentAccepted,
  fetchTransaction,
  parseTransaction,
  verifyAppleClaim,
  verifyAppleJws,
  verifyAppleNotification,
  type AppleContext,
} from "./apple.js";
import {
  PlayRejected,
  acknowledgePurchase,
  decodeRtdn,
  getProductPurchase,
  isPlaySku,
  isPurchaseToken,
  effectivePlaySettings,
  playCredential,
  playPurchase,
  playPurchasesClient,
  verifyPushJwt,
  type PlayContext,
} from "./play.js";
import {
  SteamRejected,
  isSteamAppId,
  isSteamTicket,
  steamCredential,
  verifySteamClaim,
  type SteamContext,
} from "./steam.js";
import { readCommerceSettings, type CommerceSettings } from "./settings.js";
import {
  bindingFor,
  getPurchase,
  getStoreProduct,
  isStoreProductId,
  listStoreProducts,
  parseDetail,
  purchaseKeyHash,
  recordPurchase,
  revokeRecordedPurchase,
  type RecordContext,
  type RecordOutcome,
  type VerifiedPurchase,
} from "./state.js";
import { StoreUnavailable, jsonObject } from "./http.js";

/** A claim body: a StoreKit JWS is the largest member (a few KiB). */
export const MAX_CLAIM_BODY = 32 * 1024;
/** A notification body: Apple's signed payload, or a Pub/Sub envelope. */
export const MAX_HOOK_BODY = 64 * 1024;
/** Claims per licence per minute. */
export const CLAIM_RATE = { limit: 20, windowSec: 60 } as const;
/** VERIFIED deliveries per product per minute, per store. Counted only after the store's
 *  signature or token checked out, so no unauthenticated caller can drain it. */
export const HOOK_RATE = { limit: 120, windowSec: 60 } as const;
/** Deliveries per client IP per minute, per store, BEFORE verification: bounds the CPU an
 *  unauthenticated sender can spend on signature checks without touching the product bucket. */
export const HOOK_IP_RATE = { limit: 60, windowSec: 60 } as const;

export const APP_STORE_EVENTS = "app-store-notifications";
export const PLAY_EVENTS = "play-rtdn";

/** Is `rest` (after `/distribution`) one of the commerce routes? */
export function isCommerceRoute(rest: readonly string[]): boolean {
  return (
    (rest[0] === "commerce" &&
      rest.length === 2 &&
      (rest[1] === "binding" || rest[1] === "claim")) ||
    (rest[0] === "hooks" &&
      rest.length === 2 &&
      (rest[1] === "app-store" || rest[1] === "play-rtdn"))
  );
}

export async function handleCommerceRoutes(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { rest, req } = ctx;
  // License off (or no grant writer): commerce does not exist for this product.
  if (!ctx.storeGrants || !ctx.product.services.license?.enabled) return null;
  if (rest[0] === "commerce" && rest[1] === "binding")
    return req.method === "GET" ? handleBinding(ctx) : null;
  if (rest[0] === "commerce" && rest[1] === "claim")
    return req.method === "POST" ? handleClaim(ctx) : null;
  if (rest[0] === "hooks" && rest[1] === "app-store")
    return req.method === "POST" ? handleAppStoreHook(ctx) : null;
  if (rest[0] === "hooks" && rest[1] === "play-rtdn")
    return req.method === "POST" ? handlePlayHook(ctx) : null;
  return null;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

/** The body as text, at most `max` bytes, read through the shared streaming reader so a chunked
 *  (or lying `Content-Length`) unauthenticated body is cut off while it streams. `null` = too
 *  large or unreadable. */
async function readBody(req: Request, max: number): Promise<string | null> {
  try {
    return await readCappedText(
      new Response(req.body, { headers: req.headers }),
      max,
      () => new Error("too large"),
    );
  } catch {
    return null;
  }
}

const bad = (reason: string, message: string) =>
  wireError(400, "bad_request", { reason, message });

/** A refused claim, by `recordPurchase`'s reason or a store's. */
function refusal(reason: string): Response {
  switch (reason) {
    case "binding_mismatch":
    case "bound_elsewhere":
    case "unbound":
      return wireError(403, "forbidden", {
        reason,
        message: "this purchase is bound to another licence, or to none",
      });
    case "not_owned":
      return wireError(403, "forbidden", {
        reason,
        message: "Steam does not report this account as the owner of the DLC",
      });
    case "unmapped":
      return wireError(404, "not_found", {
        reason: "unmapped_product",
        message: "this store product unlocks nothing here",
      });
    case "no_license":
      return wireError(403, "not_entitled", {
        reason,
        message: "this device has no licence to grant to: enrol first",
      });
    case "license_disabled":
      return wireError(404, "not_found");
    default:
      return wireError(400, "bad_request", {
        reason,
        message: "the store did not vouch for this purchase",
      });
  }
}

const unavailable = () =>
  wireError(503, "unavailable", {
    reason: "store_unavailable",
    message: "the store could not be reached; try again",
  });

function claimed(
  o: Extract<RecordOutcome, { ok: true }>,
  store: Store,
  productId: string,
) {
  return json({
    ok: true,
    store,
    productId,
    flag: o.flag,
    deliverable: o.deliverable,
    state: o.state,
    granted: o.state === "active",
    changed: o.changed,
  });
}

interface DeviceLicence {
  licenseId: string;
  /** The calling device, for the trust policy's `commerceClaim` gate (P6-02). */
  device: DeviceRow;
}

/** The caller's usable licence, or the refusal: 401 for a bad token or an unusable licence,
 *  403 `no_license` for a device without one. */
async function callerLicence(
  ctx: ServiceContext,
): Promise<DeviceLicence | Response> {
  const valid = await validateDeviceToken(
    ctx.env,
    ctx.db,
    ctx.product,
    bearer(ctx.req),
    ctx.now,
  );
  if ("error" in valid) return wireError(401, "unauthorized");
  if (valid.license === null) return refusal("no_license");
  if (!licenseUsable(valid.license, ctx.now))
    return wireError(401, "unauthorized");
  return { licenseId: valid.license.id, device: valid.device };
}

// ── binding ──────────────────────────────────────────────────────────────────────────────────

/**
 * `GET …/commerce/binding`: `{bindingId, products}` — the binding UUID the SDK hands the store,
 * and the store products this product maps (store, product id, flag, deliverable), so the client
 * knows what to sell and which flags its store sells (App Store 3.1.3(b): on an Apple outlet the
 * SDK hides a flag that is not also an App Store product; the licence document stays
 * outlet-agnostic).
 */
async function handleBinding(ctx: ServiceContext): Promise<Response> {
  const who = await callerLicence(ctx);
  if (who instanceof Response) return who;
  const bindingId = await bindingFor(
    ctx.db,
    ctx.product.slug,
    who.licenseId,
    ctx.now,
  );
  const settings = await readCommerceSettings(ctx.db, ctx.product.slug);
  const enabled = (s: Store) =>
    s === "app-store"
      ? settings.appStore !== null
      : s === "play"
        ? settings.play !== null
        : settings.steam !== null;
  const products = (await listStoreProducts(ctx.db, ctx.product.slug))
    .filter((p) => enabled(p.store))
    .map((p) => ({
      store: p.store,
      productId: p.store_product_id,
      flag: p.flag,
      deliverable: p.deliverable_id,
    }));
  return json(
    { bindingId, products },
    { headers: { "cache-control": "private, no-store" } },
  );
}

// ── claim ────────────────────────────────────────────────────────────────────────────────────

/** The store contexts a product is set up for (settings plus a pinned credential). */
async function appleContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<AppleContext | null> {
  if (!settings.appStore) return null;
  const credentialId = await appStoreCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.appStore.bundleId,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    settings: settings.appStore,
    credentialId,
  };
}

export async function playContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<PlayContext | null> {
  if (!settings.play) return null;
  const credentialId = await playCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.play.packageName,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    // A-16: the platform's RTDN push identity where the product leaves it unset.
    settings: await effectivePlaySettings(ctx.env, ctx.db, settings.play),
    credentialId,
  };
}

export async function steamContext(
  ctx: Pick<ServiceContext, "env" | "db" | "now"> & {
    product: { slug: string };
  },
  settings: CommerceSettings,
): Promise<SteamContext | null> {
  if (!settings.steam) return null;
  const credentialId = await steamCredential(
    ctx.env,
    ctx.db,
    ctx.product.slug,
    settings.steam.appId,
  );
  if (!credentialId) return null;
  return {
    env: ctx.env,
    db: ctx.db,
    product: ctx.product.slug,
    now: ctx.now,
    settings: settings.steam,
    credentialId,
  };
}

/**
 * `POST …/commerce/claim` with one of
 *   `{store: "app-store", signedTransaction}`,
 *   `{store: "play", productId, purchaseToken}`,
 *   `{store: "steam", ticket, dlcAppId}`.
 */
async function handleClaim(ctx: ServiceContext): Promise<Response | null> {
  const { env, db, product, now } = ctx;
  const raw = await readBody(ctx.req, MAX_CLAIM_BODY);
  if (raw === null)
    return errorResponse(413, "body_too_large", "claim body too large");
  // Authenticate before anything about the product's store setup is consulted, so only a device
  // of this product learns which stores are configured.
  const who = await callerLicence(ctx);
  if (who instanceof Response) return who;
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "commerceClaim", id: who.licenseId, ...CLAIM_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many claims");
  // P6-02 — the operator's device-trust policy. Log-only unless enforced: a basic device the
  // policy would refuse is audited and its claim proceeds (`core/deviceTrust.ts`).
  const untrusted = await trustRefusal(
    env,
    db,
    product,
    who.device,
    "commerceClaim",
    now,
    "wire",
  );
  if (untrusted) return untrusted;
  const body = jsonObject(raw);
  if (!body || !isStore(body.store))
    return bad(
      "bad_body",
      'body must name a store: "app-store", "play" or "steam"',
    );
  const store = body.store;

  const settings = await readCommerceSettings(db, product.slug);
  const storeCtx =
    store === "app-store"
      ? await appleContext(ctx, settings)
      : store === "play"
        ? await playContext(ctx, settings)
        : await steamContext(ctx, settings);
  if (!storeCtx) return null;
  const binding = await bindingFor(db, product.slug, who.licenseId, now);
  const record: RecordContext = {
    db,
    product: product.slug,
    now,
    storeGrants: ctx.storeGrants,
    claimLicenseId: who.licenseId,
  };

  try {
    let purchase: VerifiedPurchase;
    if (store === "app-store") {
      if (typeof body.signedTransaction !== "string")
        return bad("bad_body", "signedTransaction is required");
      purchase = await verifyAppleClaim(
        storeCtx as AppleContext,
        body.signedTransaction,
      );
    } else if (store === "play") {
      if (!isPlaySku(body.productId) || !isPurchaseToken(body.purchaseToken))
        return bad("bad_body", "productId and purchaseToken are required");
      const pctx = storeCtx as PlayContext;
      const api = playPurchasesClient(pctx, "commerce:claim");
      const p = await getProductPurchase(
        api,
        body.productId,
        body.purchaseToken,
      );
      purchase = playPurchase(
        pctx.settings,
        body.productId,
        body.purchaseToken,
        p,
      );
      const out = await recordPurchase(record, purchase);
      if (!out.ok) return refusal(out.reason);
      await acknowledgeOnce(pctx, api, out, purchase);
      return claimed(out, store, body.productId);
    } else {
      if (!isSteamTicket(body.ticket) || !isSteamAppId(body.dlcAppId))
        return bad("bad_body", "ticket (hex) and dlcAppId are required");
      if (!isStoreProductId("steam", body.dlcAppId))
        return bad("bad_body", "dlcAppId must be a Steam app id");
      // A-16: only an app this product mapped is ever asked about. Without this a device could
      // use the product's (or the platform group's) publisher key as an ownership oracle for any
      // app the key may query. The refusal is the same as a non-owner's, so it says nothing.
      if (!(await getStoreProduct(db, product.slug, "steam", body.dlcAppId)))
        return refusal("not_owned");
      purchase = await verifySteamClaim(
        storeCtx as SteamContext,
        body.ticket,
        body.dlcAppId,
        binding,
      );
      if (purchase.state !== "active") {
        // A non-owner gets nothing; one who owned it before loses the grant.
        const hash = await purchaseKeyHash("steam", purchase.purchaseKey);
        if (!(await getPurchase(db, product.slug, "steam", hash)))
          return refusal("not_owned");
      }
    }
    const out = await recordPurchase(record, purchase);
    if (!out.ok) return refusal(out.reason);
    if (store === "steam" && out.state !== "active")
      return refusal("not_owned");
    return claimed(out, store, purchase.storeProductId);
  } catch (e) {
    if (
      e instanceof AppleRejected ||
      e instanceof PlayRejected ||
      e instanceof SteamRejected
    )
      return refusal(e.reason);
    if (e instanceof StoreUnavailable) return unavailable();
    throw e;
  }
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

// ── App Store Server Notifications V2 ────────────────────────────────────────────────────────

async function handleAppStoreHook(
  ctx: ServiceContext,
): Promise<Response | null> {
  const { env, db, product, now } = ctx;
  const settings = await readCommerceSettings(db, product.slug);
  const actx = await appleContext(ctx, settings);
  if (!actx) return null;
  // Unverified traffic is limited per client IP only; the product-wide bucket below counts only
  // deliveries Apple signed, so junk cannot crowd out a real refund notification.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "appStoreHookIp", id: clientIp(ctx.req), ...HOOK_IP_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many notifications");
  const raw = await readBody(ctx.req, MAX_HOOK_BODY);
  if (raw === null)
    return errorResponse(413, "body_too_large", "notification too large");
  const body = jsonObject(raw);
  if (!body || typeof body.signedPayload !== "string")
    return bad("bad_body", "body must be {signedPayload}");

  let n;
  try {
    n = await verifyAppleNotification(body.signedPayload, now);
  } catch (e) {
    if (e instanceof AppleRejected)
      return wireError(401, "unauthorized", { reason: e.reason });
    throw e;
  }
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "appStoreHook", id: "app-store", ...HOOK_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many notifications");
  const write = { db, product: product.slug, now };
  const seen = await eventSeen(
    db,
    product.slug,
    APP_STORE_EVENTS,
    n.notificationUUID,
  );
  if (seen !== null && seen.outcome !== "failed")
    return json({ ok: true, duplicate: true });
  const event = (outcome: ConnectorEventOutcome) =>
    recordEvent(write, APP_STORE_EVENTS, {
      id: n.notificationUUID,
      type: n.subtype
        ? `${n.notificationType}.${n.subtype}`
        : n.notificationType,
      instanceType: null,
      instanceId: null,
      outcome,
      raw: body.signedPayload as string,
    });

  // A verified notification for another app, or from an environment this product refuses (a
  // sandbox delivery to a production product), changes nothing — answered 200 so Apple stops.
  if (
    n.bundleId !== actx.settings.bundleId ||
    (n.environment === "Production" &&
      actx.settings.appAppleId !== null &&
      n.appAppleId !== actx.settings.appAppleId)
  ) {
    await event("ignored");
    return json({ ok: true, ignored: "wrong_app" });
  }
  if (!environmentAccepted(n.environment, actx.settings)) {
    await event("ignored");
    return json({ ok: true, ignored: "environment" });
  }
  if (
    !(APPLE_ACTED_TYPES as readonly string[]).includes(n.notificationType) ||
    !n.signedTransactionInfo
  ) {
    await event("stored");
    return json({ ok: true });
  }

  let outcome: ConnectorEventOutcome;
  try {
    const hinted = parseTransaction(
      await verifyAppleJws(n.signedTransactionInfo, now),
    );
    // The notification names the transaction; the Server API says what it is.
    const tx = await fetchTransaction(
      actx,
      hinted.transactionId,
      hinted.environment,
      "commerce:notification",
    );
    checkTransaction(tx, actx.settings);
    const out = await recordPurchase(
      { db, product: product.slug, now, storeGrants: ctx.storeGrants },
      applePurchase(tx),
    );
    outcome = out.ok
      ? "applied"
      : out.reason === "license_disabled"
        ? "failed"
        : "unresolved";
  } catch (e) {
    if (e instanceof StoreUnavailable) {
      await event("failed");
      return unavailable();
    }
    if (e instanceof AppleRejected) {
      await event("ignored");
      return json({ ok: true, ignored: e.reason });
    }
    throw e;
  }
  await event(outcome);
  return json({ ok: true });
}

// ── Play RTDN ────────────────────────────────────────────────────────────────────────────────

async function handlePlayHook(ctx: ServiceContext): Promise<Response | null> {
  const { env, db, product, now } = ctx;
  const settings = await readCommerceSettings(db, product.slug);
  const pctx = await playContext(ctx, settings);
  if (!pctx) return null;
  // Unverified traffic is limited per client IP; the product bucket counts verified pushes only.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "playRtdnHookIp", id: clientIp(ctx.req), ...HOOK_IP_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many notifications");
  // Authenticate the push BEFORE reading or believing the body.
  const auth = await verifyPushJwt(
    env,
    ctx.req.headers.get("authorization"),
    pctx.settings,
    now,
  );
  if (!auth.ok) return wireError(401, "unauthorized", { reason: auth.reason });
  const raw = await readBody(ctx.req, MAX_HOOK_BODY);
  if (raw === null)
    return errorResponse(413, "body_too_large", "push body too large");
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { bucket: "playRtdnHook", id: "play-rtdn", ...HOOK_RATE },
      now,
    ))
  )
    return errorResponse(429, "rate_limited", "too many notifications");
  const body = jsonObject(raw);
  const msg = body ? decodeRtdn(body) : null;
  // A malformed push is acknowledged (2xx) so Pub/Sub does not redeliver it forever.
  if (!msg) return json({ ok: true, ignored: "not_rtdn" });

  const write = { db, product: product.slug, now };
  const seen = await eventSeen(db, product.slug, PLAY_EVENTS, msg.messageId);
  if (seen !== null && seen.outcome !== "failed")
    return json({ ok: true, duplicate: true });
  const event = (type: string, outcome: ConnectorEventOutcome) =>
    recordEvent(write, PLAY_EVENTS, {
      id: msg.messageId,
      type,
      instanceType: null,
      instanceId: null,
      outcome,
      raw: msg.raw,
    });

  if (msg.packageName !== pctx.settings.packageName) {
    await event("other-package", "ignored");
    return json({ ok: true, ignored: "wrong_app" });
  }
  const record = {
    db,
    product: product.slug,
    now,
    storeGrants: ctx.storeGrants,
  };
  try {
    if (msg.voided) {
      const hash = await purchaseKeyHash("play", msg.voided.purchaseToken);
      const out = await revokeRecordedPurchase(record, "play", hash, {
        voidedAt: now,
      });
      await event(
        "voidedPurchase",
        out === null ? "unresolved" : out.ok ? "applied" : "failed",
      );
      return json({ ok: true });
    }
    if (msg.oneTime) {
      const api = playPurchasesClient(pctx, "commerce:notification");
      const p = await getProductPurchase(
        api,
        msg.oneTime.sku,
        msg.oneTime.purchaseToken,
      );
      const purchase = playPurchase(
        pctx.settings,
        msg.oneTime.sku,
        msg.oneTime.purchaseToken,
        p,
      );
      const out = await recordPurchase(record, purchase);
      if (out.ok) await acknowledgeOnce(pctx, api, out, purchase);
      await event(
        `oneTimeProduct.${msg.oneTime.notificationType}`,
        out.ok
          ? "applied"
          : out.reason === "license_disabled"
            ? "failed"
            : "unresolved",
      );
      return json({ ok: true });
    }
    await event(msg.test ? "test" : "other", "stored");
    return json({ ok: true });
  } catch (e) {
    if (e instanceof StoreUnavailable) {
      await event("oneTimeProduct", "failed");
      return unavailable();
    }
    if (e instanceof PlayRejected) {
      await event("oneTimeProduct", "ignored");
      return json({ ok: true, ignored: e.reason });
    }
    throw e;
  }
}

export { appleContext };
