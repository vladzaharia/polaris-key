/**
 * The App Store Server API client's custody and test-notification half (P0-27a, CM-29): which
 * credential serves a bundle id (the product's own key, else the platform's team In-App Purchase
 * key), a bearer token for it, and A-17c's "Request a Test Notification" calls. Shared by
 * Commerce (transaction re-reads) and Distribution's App Store Connect provisioning (the test
 * notification), so it lives in Core: it imports no service.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import {
  checkOutletCredentialPin,
  listOutletCredentials,
} from "../../outletCredentials.js";
import {
  appStoreServerToken,
  platformAppStoreServerToken,
} from "../../outletTokens.js";
import {
  platformPin,
  resolvePlatformCredential,
} from "../../platformCredentials.js";
import { StoreUnavailable, storeJson } from "../http.js";

export const APP_STORE_SERVER_API = "https://api.storekit.apple.com";
export const APP_STORE_SERVER_API_SANDBOX =
  "https://api.storekit-sandbox.apple.com";

/** The handle `appStoreCredential` answers when the product falls back to the platform team
 *  In-App Purchase key (A-16). A `:` cannot appear in a product credential id, so it never
 *  names one. */
export const PLATFORM_APP_STORE_SERVER_CREDENTIAL =
  "platform:app-store.in-app-purchase-key";

/**
 * The `app-store-server-key` credential pinned to `bundleId` (lowest id), or null. Metadata
 * only: nothing is opened.
 *
 * A-16: a product with NO active `app-store-server-key` of its own falls back to the platform's
 * team In-App Purchase key (console credential, else `PLATFORM_APP_STORE_SERVER_KEY`) — but only
 * when the product's platform pin on it is `bundleId`; the answer is then
 * `PLATFORM_APP_STORE_SERVER_CREDENTIAL`. A product's own key wins, and an own key pinned
 * elsewhere never falls through to the team key.
 */
export async function appStoreCredential(
  env: Env,
  db: Db,
  product: string,
  bundleId: string,
): Promise<string | null> {
  const own = (await listOutletCredentials(db, product)).filter(
    (c) => c.status === "active" && c.kind === "app-store-server-key",
  );
  if (own.length > 0)
    return (
      own.find((c) => checkOutletCredentialPin(c, bundleId).ok)?.id ?? null
    );
  const id = "app-store.in-app-purchase-key";
  if (!(await resolvePlatformCredential(env, db, id))) return null;
  return (await platformPin(db, id, product)) === bundleId
    ? PLATFORM_APP_STORE_SERVER_CREDENTIAL
    : null;
}

/** What an App Store Server API call needs: the credential `appStoreCredential` chose for
 *  `bundleId` (the token's `bid`; the custody checks the pin again when it opens the key). */
export interface AppleServerContext {
  env: Env;
  db: Db;
  product: string;
  now: number;
  credentialId: string;
  bundleId: string;
}

/** A bearer token for the App Store Server API. Throws `StoreUnavailable` (401) when unusable. */
export async function serverApiToken(
  ctx: AppleServerContext,
  use: string,
): Promise<string> {
  const token =
    ctx.credentialId === PLATFORM_APP_STORE_SERVER_CREDENTIAL
      ? await platformAppStoreServerToken(
          ctx.env,
          ctx.db,
          ctx.product,
          ctx.bundleId,
          use,
          ctx.now,
        )
      : await appStoreServerToken(
          ctx.env,
          ctx.db,
          ctx.product,
          ctx.credentialId,
          ctx.bundleId,
          use,
          ctx.now,
        );
  if (!token) throw new StoreUnavailable("app-store credential", 401);
  return token;
}

// ── test notifications (A-17c) ───────────────────────────────────────────────────────────────

/** The App Store Server API environment a test notification is requested in. Apple sends it to
 *  the URL configured for that environment (production or sandbox). */
export type AppleServerEnvironment = "Production" | "Sandbox";

const serverOrigin = (environment: AppleServerEnvironment) =>
  environment === "Sandbox"
    ? APP_STORE_SERVER_API_SANDBOX
    : APP_STORE_SERVER_API;

/** Apple's test-notification token: opaque, but only these characters ever go into a path. */
const TEST_TOKEN = /^[A-Za-z0-9_.:-]{1,200}$/;

export function isTestNotificationToken(v: unknown): v is string {
  return typeof v === "string" && TEST_TOKEN.test(v);
}

export type TestNotificationRequest =
  | { status: "sent"; token: string }
  /** 404: no App Store Server Notifications URL is configured for that environment. */
  | { status: "url_missing" }
  /** 400: Apple refused the request (its numeric `errorCode`, never the message). */
  | { status: "refused"; errorCode: number | null };

const errorCodeOf = (body: Record<string, unknown> | null): number | null =>
  typeof body?.errorCode === "number" && Number.isSafeInteger(body.errorCode)
    ? body.errorCode
    : null;

/**
 * "Request a Test Notification" (`POST /inApps/v1/notifications/test`): Apple sends a `TEST`
 * notification (always V2) to the URL configured for `environment`, which the hook stores as an
 * event (`APP_STORE_EVENTS`, type `TEST`). Throws `StoreUnavailable` on a transport failure.
 */
export async function requestTestNotification(
  ctx: AppleServerContext,
  environment: AppleServerEnvironment,
  use: string,
): Promise<TestNotificationRequest> {
  const token = await serverApiToken(ctx, use);
  const res = await storeJson(
    `${serverOrigin(environment)}/inApps/v1/notifications/test`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
    "app-store notifications.test",
    [400, 404],
  );
  if (res.status === 404) return { status: "url_missing" };
  if (res.status === 400)
    return { status: "refused", errorCode: errorCodeOf(res.body) };
  const t = res.body?.testNotificationToken;
  if (!isTestNotificationToken(t))
    throw new StoreUnavailable("app-store notifications.test", 502);
  return { status: "sent", token: t };
}

/** One delivery attempt Apple reports: when, and its result token (`SUCCESS`, `TIMED_OUT`…). */
export interface TestNotificationAttempt {
  at: number | null;
  result: string;
}

export type TestNotificationStatus =
  | { found: true; attempts: TestNotificationAttempt[] }
  | { found: false };

const RESULT = /^[A-Z][A-Z_]{0,63}$/;

/**
 * "Get Test Notification Status" (`GET /inApps/v1/notifications/test/{token}`): Apple's delivery
 * attempts for one test notification. The signed payload Apple returns is not kept here: the
 * hook's own stored `TEST` event is the proof that it arrived.
 */
export async function getTestNotificationStatus(
  ctx: AppleServerContext,
  environment: AppleServerEnvironment,
  testToken: string,
  use: string,
): Promise<TestNotificationStatus> {
  if (!isTestNotificationToken(testToken)) return { found: false };
  const token = await serverApiToken(ctx, use);
  const res = await storeJson(
    `${serverOrigin(environment)}/inApps/v1/notifications/test/${encodeURIComponent(testToken)}`,
    {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    },
    "app-store notifications.test.get",
    [400, 404],
  );
  if (res.status !== 200) return { found: false };
  const raw = Array.isArray(res.body?.sendAttempts)
    ? res.body.sendAttempts
    : [];
  const attempts: TestNotificationAttempt[] = [];
  for (const a of raw.slice(0, 20)) {
    const o = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
    const result = o.sendAttemptResult;
    if (typeof result !== "string" || !RESULT.test(result)) continue;
    const at = o.attemptDate;
    attempts.push({
      at:
        typeof at === "number" && Number.isFinite(at)
          ? Math.floor(at / 1000)
          : null,
      result,
    });
  }
  return { found: true, attempts };
}
