/**
 * The App Store side of the commerce bridge (P6-01; notes/E1 §F1–§F3, S-09).
 *
 * **Signed by Apple, chained to a pinned root.** A StoreKit 2 transaction (`jwsRepresentation`),
 * an App Store Server Notifications V2 `signedPayload` and its `signedTransactionInfo` are all
 * ES256 compact JWS whose header carries an `x5c` chain. `verifyAppleJws` ports the App Store
 * Server Library's checks: exactly three certificates, ending byte-for-byte at Apple Root CA - G3
 * (`root.ts`), the intermediate carrying `1.2.840.113635.100.6.2.1` and the leaf
 * `1.2.840.113635.100.6.11.1`, every link signed and in validity at the payload's `signedDate`
 * (never in the future), then the JWS signature under the leaf key. An `Xcode` environment —
 * StoreKit Testing's self-signed single-certificate chain — fails the chain and is also refused
 * by name (S-09).
 *
 * **The device only forwards; the Server API is truth.** A claimed transaction is re-read from the
 * App Store Server API (`GET /inApps/v1/transactions/{transactionId}`, production
 * `api.storekit.apple.com`, sandbox `api.storekit-sandbox.apple.com`) with an
 * `app-store-server-key` bearer token, and only the API's own signed copy decides — its
 * `bundleId`, environment, ownership, `appAccountToken` and `revocationDate`. A notification is a
 * hint the same way: it names the transaction, the API says what it is.
 *
 * **What it grants.** Non-consumables only (consumables and subscriptions are out of scope), owned
 * as `PURCHASED` (a Family Sharing copy belongs to the purchaser's licence, not the family
 * member's device). `appAccountToken` is compared as a UUID (S-09: the JWS carries it in lower
 * case). Notification types acted on: ONE_TIME_CHARGE, REFUND, REVOKE, REFUND_REVERSED; TEST and
 * every other type is stored raw.
 *
 * The pinned root can be replaced in tests only (`setAppleRootsForTesting`; the reach test keeps
 * every `src/` file from calling it).
 */

import { b64urlDecodeStrict } from "../../../../platform/bytes.js";
import { parseJsonObject } from "../../../../platform/json.js";
import type { Db } from "../../../../db/types.js";
import type { Env } from "../../../../platform/env.js";
import {
  X509Error,
  base64ToBytes,
  verifyChain,
} from "../../../../core/trust/x509.js";
import { APPLE_ROOT_CA_G3_DER } from "./root.js";
import type { AppStoreSettings } from "../../settings.js";
import { normaliseBinding, type VerifiedPurchase } from "../../state.js";
import { StoreUnavailable, storeJson } from "../../../../core/stores/http.js";
import {
  APP_STORE_SERVER_API,
  APP_STORE_SERVER_API_SANDBOX,
  serverApiToken,
  type AppleServerContext,
} from "../../../../core/stores/apple/server.js";
export {
  PLATFORM_APP_STORE_SERVER_CREDENTIAL,
  appStoreCredential,
  type AppleServerContext,
} from "../../../../core/stores/apple/server.js";

export const APPLE_LEAF_OID = "1.2.840.113635.100.6.11.1";
export const APPLE_INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

/** The notification types that change a grant. */
export const APPLE_ACTED_TYPES = [
  "ONE_TIME_CHARGE",
  "REFUND",
  "REVOKE",
  "REFUND_REVERSED",
] as const;

/** A StoreKit / notification JWS is a few KiB; anything past this is not Apple's. */
export const MAX_APPLE_JWS = 32 * 1024;

let rootsOverride: readonly Uint8Array[] | null = null;

/** TEST ONLY: replace the pinned root (a generated chain's root), or restore it with `null`. */
export function setAppleRootsForTesting(
  roots: readonly Uint8Array[] | null,
): void {
  rootsOverride = roots;
}

function appleRoots(): readonly Uint8Array[] {
  return rootsOverride ?? [APPLE_ROOT_CA_G3_DER];
}

/** Why an App Store JWS or transaction was refused. Becomes the claim's `reason`. */
export type AppleRejection =
  | "invalid_jws"
  | "untrusted_chain"
  | "wrong_app"
  | "environment"
  | "unsupported_type"
  | "family_shared"
  | "transaction_mismatch"
  | "unknown_transaction";

/** A notification (and the Server API's own copy) is signed within a day of its use. */
export const APPLE_MAX_SIGNED_AGE_SECONDS = 24 * 60 * 60;

export class AppleRejected extends Error {
  constructor(readonly reason: AppleRejection) {
    super(`app store: ${reason}`);
    this.name = "AppleRejected";
  }
}

const reject = (reason: AppleRejection): never => {
  throw new AppleRejected(reason);
};

/**
 * Verify an Apple-signed JWS (see the header) and answer its payload. Throws `AppleRejected`
 * (`invalid_jws`, `untrusted_chain`).
 */
export async function verifyAppleJws(
  jws: string,
  now: number,
  opts: { maxAgeSeconds?: number } = {},
): Promise<Record<string, unknown>> {
  if (typeof jws !== "string" || jws.length > MAX_APPLE_JWS)
    return reject("invalid_jws");
  const parts = jws.split(".");
  if (parts.length !== 3) return reject("invalid_jws");
  const [h, p, s] = parts as [string, string, string];
  const headerBytes = b64urlDecodeStrict(h);
  const payloadBytes = b64urlDecodeStrict(p);
  const sig = b64urlDecodeStrict(s);
  if (!headerBytes || !payloadBytes || !sig || sig.length !== 64)
    return reject("invalid_jws");
  const header = parseJsonObject(new TextDecoder().decode(headerBytes));
  const payload = parseJsonObject(new TextDecoder().decode(payloadBytes));
  if (!header || !payload || header.alg !== "ES256")
    return reject("invalid_jws");
  const x5c = header.x5c;
  if (
    !Array.isArray(x5c) ||
    x5c.length !== 3 ||
    !x5c.every((c) => typeof c === "string")
  )
    return reject("untrusted_chain");
  // The chain is checked at the payload's signedDate (the library's offline rule), never later
  // than now: an old StoreKit JWS stays verifiable after its leaf rotates, and the Server API
  // copy — signed at the time of the call — is what decides a grant anyway.
  const signedMs = payload.signedDate;
  let at = now;
  if (typeof signedMs === "number" && Number.isFinite(signedMs)) {
    const signed = Math.floor(signedMs / 1000);
    if (signed > now + 300) return reject("invalid_jws");
    // Where the caller wants a live signature (a notification, the
    // Server API copy), signedDate cannot be backdated to a time an old or leaked leaf was valid.
    if (opts.maxAgeSeconds !== undefined && signed < now - opts.maxAgeSeconds)
      return reject("invalid_jws");
    at = signed;
  } else if (opts.maxAgeSeconds !== undefined) return reject("invalid_jws");
  let key: CryptoKey;
  try {
    ({ key } = await verifyChain(
      (x5c as string[]).map((c) => base64ToBytes(c)),
      {
        roots: appleRoots(),
        at,
        length: 3,
        leafOids: [APPLE_LEAF_OID],
        intermediateOids: [APPLE_INTERMEDIATE_OID],
        // The leaf signs the JWS: a keyUsage that is present must allow digitalSignature.
        leafDigitalSignature: "ifPresent",
      },
    ));
  } catch (e) {
    if (e instanceof X509Error) return reject("untrusted_chain");
    throw e;
  }
  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      sig as BufferSource,
      new TextEncoder().encode(`${h}.${p}`) as BufferSource,
    );
  } catch {
    return reject("invalid_jws");
  }
  if (!ok) return reject("invalid_jws");
  return payload;
}

// ── transactions ─────────────────────────────────────────────────────────────────────────────

export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  environment: string;
  type: string;
  inAppOwnershipType: string;
  appAccountToken: string | null;
  revoked: boolean;
}

const TX_ID = /^[0-9]{1,32}$/;

/** The fields the bridge reads from a decoded transaction. Throws `AppleRejected`. */
export function parseTransaction(p: Record<string, unknown>): AppleTransaction {
  const str = (k: string) =>
    typeof p[k] === "string" ? (p[k] as string) : null;
  const transactionId = str("transactionId");
  const originalTransactionId = str("originalTransactionId") ?? transactionId;
  const bundleId = str("bundleId");
  const productId = str("productId");
  const environment = str("environment");
  if (
    !transactionId ||
    !TX_ID.test(transactionId) ||
    !originalTransactionId ||
    !TX_ID.test(originalTransactionId) ||
    !bundleId ||
    !productId ||
    !environment
  )
    return reject("invalid_jws");
  return {
    transactionId,
    originalTransactionId,
    bundleId,
    productId,
    environment,
    type: str("type") ?? "",
    inAppOwnershipType: str("inAppOwnershipType") ?? "PURCHASED",
    appAccountToken: normaliseBinding(p.appAccountToken),
    revoked: typeof p.revocationDate === "number",
  };
}

/** The environments a product accepts: Production, plus Sandbox when the operator allows it.
 *  `Xcode` never. */
export function environmentAccepted(
  env: string,
  settings: AppStoreSettings,
): boolean {
  return env === "Production" || (env === "Sandbox" && settings.acceptSandbox);
}

/** The bridge's checks on one transaction. Throws `AppleRejected`. */
export function checkTransaction(
  tx: AppleTransaction,
  settings: AppStoreSettings,
): void {
  if (tx.bundleId !== settings.bundleId) reject("wrong_app");
  if (!environmentAccepted(tx.environment, settings)) reject("environment");
  if (tx.type !== "Non-Consumable") reject("unsupported_type");
  if (tx.inAppOwnershipType !== "PURCHASED") reject("family_shared");
}

// ── the App Store Server API ─────────────────────────────────────────────────────────────────

export interface AppleContext {
  env: Env;
  db: Db;
  product: string;
  now: number;
  settings: AppStoreSettings;
  credentialId: string;
}

/**
 * Re-read one transaction from the App Store Server API and verify Apple's copy. Throws
 * `AppleRejected` (`unknown_transaction`, a chain or JWS failure) or `StoreUnavailable`.
 */
export async function fetchTransaction(
  ctx: AppleContext,
  transactionId: string,
  environment: string,
  use: string,
): Promise<AppleTransaction> {
  if (!TX_ID.test(transactionId)) reject("invalid_jws");
  const token = await serverApiToken(
    { ...ctx, bundleId: ctx.settings.bundleId },
    use,
  );
  const origin =
    environment === "Sandbox"
      ? APP_STORE_SERVER_API_SANDBOX
      : APP_STORE_SERVER_API;
  const res = await storeJson(
    `${origin}/inApps/v1/transactions/${transactionId}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
    "app-store transactions.get",
    [400, 404],
  );
  if (res.status !== 200) return reject("unknown_transaction");
  const signed = res.body?.signedTransactionInfo;
  if (typeof signed !== "string")
    throw new StoreUnavailable("app-store transactions.get", 502);
  const tx = parseTransaction(
    await verifyAppleJws(signed, ctx.now, {
      maxAgeSeconds: APPLE_MAX_SIGNED_AGE_SECONDS,
    }),
  );
  if (tx.transactionId !== transactionId) reject("transaction_mismatch");
  return tx;
}

/** A transaction the Server API vouched for, as the store-agnostic record. */
export function applePurchase(tx: AppleTransaction): VerifiedPurchase {
  return {
    store: "app-store",
    purchaseKey: tx.originalTransactionId,
    storeProductId: tx.productId,
    environment: tx.environment,
    state: tx.revoked ? "revoked" : "active",
    binding: tx.appAccountToken,
    detail: {
      transactionId: tx.transactionId,
      originalTransactionId: tx.originalTransactionId,
      environment: tx.environment,
    },
  };
}

/**
 * A device's claim: verify the StoreKit JWS it forwarded, check it, then re-read the transaction
 * from the Server API and check Apple's copy (which decides). Throws `AppleRejected` or
 * `StoreUnavailable`.
 */
export async function verifyAppleClaim(
  ctx: AppleContext,
  signedTransaction: string,
): Promise<VerifiedPurchase> {
  const device = parseTransaction(
    await verifyAppleJws(signedTransaction, ctx.now),
  );
  checkTransaction(device, ctx.settings);
  const tx = await fetchTransaction(
    ctx,
    device.transactionId,
    device.environment,
    "commerce:claim",
  );
  checkTransaction(tx, ctx.settings);
  return applePurchase(tx);
}
