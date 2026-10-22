/**
 * App Store Server Notifications V2: verify a `signedPayload` and read its envelope. Split from
 * `purchases.ts` by P0-27.4 (CM-29 D3); no behaviour change.
 */

import {
  APPLE_MAX_SIGNED_AGE_SECONDS,
  AppleRejected,
  verifyAppleJws,
} from "./purchases.js";

// ── notifications ────────────────────────────────────────────────────────────────────────────

export interface AppleNotification {
  notificationUUID: string;
  notificationType: string;
  subtype: string | null;
  environment: string;
  bundleId: string;
  appAppleId: number | null;
  signedTransactionInfo: string | null;
}

const UUID_ANY =
  /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;

/** Verify a Notifications V2 `signedPayload` and read its envelope. Throws `AppleRejected`. */
export async function verifyAppleNotification(
  signedPayload: string,
  now: number,
): Promise<AppleNotification> {
  const p = await verifyAppleJws(signedPayload, now, {
    maxAgeSeconds: APPLE_MAX_SIGNED_AGE_SECONDS,
  });
  const data =
    p.data && typeof p.data === "object" && !Array.isArray(p.data)
      ? (p.data as Record<string, unknown>)
      : {};
  if (
    typeof p.notificationUUID !== "string" ||
    !UUID_ANY.test(p.notificationUUID) ||
    typeof p.notificationType !== "string" ||
    p.notificationType.length > 64
  )
    throw new AppleRejected("invalid_jws");
  return {
    notificationUUID: p.notificationUUID.toLowerCase(),
    notificationType: p.notificationType,
    subtype: typeof p.subtype === "string" ? p.subtype : null,
    environment: typeof data.environment === "string" ? data.environment : "",
    bundleId: typeof data.bundleId === "string" ? data.bundleId : "",
    appAppleId: typeof data.appAppleId === "number" ? data.appAppleId : null,
    signedTransactionInfo:
      typeof data.signedTransactionInfo === "string"
        ? data.signedTransactionInfo
        : null,
  };
}
