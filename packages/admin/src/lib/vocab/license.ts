/**
 * Licence words both apps share (P0-35): when a licence is "expiring", how a device count and an
 * expiry read, and the portal's origin wording for a licence that came from signing in. The key
 * format is `@polaris-key/manifest`'s (`checkLicenseKey`); the status models stay with their
 * apps (the console reads a licence as an operator, the portal as its holder).
 */
import { t } from "../copy.js";

/** A licence ending within this many days reads as expiring soon, in both apps. */
export const EXPIRES_SOON_DAYS = 14;

/** "Expires in 9 days". `tomorrow` words one day as "Expires tomorrow" (the portal's habit). */
export function expiresInText(
  days: number,
  opts: { tomorrow?: boolean } = {},
): string {
  if (days <= 1 && opts.tomorrow) return "Expires tomorrow";
  return `Expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** "2 devices", or "2 of 3 devices" when the seat limit is known (G5). */
export function devicesText(n: number, limit?: number | null): string {
  if (limit != null && limit > 0)
    return `${n} of ${limit} ${limit === 1 ? "device" : "devices"}`;
  return `${n} ${n === 1 ? "device" : "devices"}`;
}

/**
 * Every licence is account-bound, so none is labelled by type: how it came to be is a quiet
 * origin in plain words (owner decision, 2026-10-05: no "Account-wide" label).
 */
export const FROM_SIGNING_IN = t("signin.choice.origin.signIn");

/**
 * The **License source** of a licence granted automatically through OIDC, by the product's
 * auto-issue or a group grant when the person signed in (the Worker's `signin` origin): "Automatic
 * grant", sentence case (owner polish 2026-10-07; P0-36).
 */
export const AUTOMATIC_GRANT = "Automatic grant";
