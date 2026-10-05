/**
 * What every login-card provider hands to `signIn(verifiedIdentity)` (I-06).
 *
 * `identity` is the account-layer credential: issuer, subject, kind, the provider's email and
 * whether the provider itself asserted it verified. I-07's interstitial reads `emailVerified` to
 * decide whether the address needs a code (a provider-verified email does not; owner, S-16
 * header). `profile` is display material only, never an identifier: the name and avatar a
 * provider offered, for the interstitial and profile import (PX-W16). Nothing here is stored by
 * the provider modules, and no upstream token survives the callback (S-16 §5.5).
 */

import type { VerifiedIdentity } from "../accounts/signIn.js";
import type { SignInProviderKind } from "./config.js";

export interface ProviderProfile {
  displayName: string | null;
  /** An https avatar on the provider's own CDN, or `null`. Not fetched or stored here. */
  avatarUrl: string | null;
  /** Apple only: the name Apple sends on the FIRST consent and never again (S-16 §5.2). It is an
   *  unsigned form field, so it is a display suggestion and nothing more. */
  firstConsentName?: string | null;
  /** Apple only: the email is a private-relay address, deliverable only from registered sender
   *  domains (I-18's `EMAIL_APPLE_RELAY`). */
  privateRelayEmail?: boolean;
}

export interface ProviderSignInResult {
  provider: SignInProviderKind;
  identity: VerifiedIdentity;
  profile: ProviderProfile;
}

/** Trim a provider-supplied display string: no control characters, bounded. */
export function cleanDisplay(v: unknown, max = 100): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max).trim() : s;
}

/** An https URL whose host is one of `hostSuffixes` (exact or a subdomain), else `null`. */
export function cleanAvatarUrl(
  v: unknown,
  hostSuffixes: readonly string[],
): string | null {
  if (typeof v !== "string" || v.length > 2048) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || u.port) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    return hostSuffixes.some((s) => host === s || host.endsWith(`.${s}`))
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}
