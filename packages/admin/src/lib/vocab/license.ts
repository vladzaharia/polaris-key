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
    return t("signin.choice.devices", { used: n, limit });
  return t("devices.count", { count: n });
}

/**
 * The **License source** of a license issued when the person signed in (the Worker's `signin`
 * origin) as the person sees it: "Sign-in". The console says "Automatic grant" (the glossary term,
 * concepts.md) and keeps its own literal; the catalog holds these words
 * (`signin.choice.origin.signIn`) so the kits say the same.
 */
export const SIGN_IN_ORIGIN = t("signin.choice.origin.signIn");
