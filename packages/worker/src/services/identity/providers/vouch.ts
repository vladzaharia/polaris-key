/**
 * The one predicate for "the provider vouches for this email" (PX-W15; SIGN-IN.md §3.5): when a
 * provider's own assertion stands in for our code, and so when an address may be stored as
 * verified on a link (verified emails feed the licence claim rules).
 *
 * Applied where a provider's answer is made (`providers/google.ts`), so every caller of
 * `completeGoogleSignIn` (the login card, a later connect flow) gets the narrowed `emailVerified`,
 * and again as an identity enters the email gate (`card/gate.ts`), which covers every other front
 * door. Re-applying it is a no-op.
 */

import type { VerifiedIdentity } from "../accounts/signIn.js";

/** Google's consumer domains: an address there is Google's own, so `email_verified` is current. */
const GOOGLE_CONSUMER_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

/**
 * Whether the provider's own assertion stands in for our code (owner, 2026-10-04; for Google,
 * lead decision 2026-10-06). Apple's verified address always does, a private-relay address
 * included. Google's `email_verified` alone does not: for an address outside Google's own domains
 * it only says Google verified it once (a former employee's company address stays "verified"), so
 * it counts only for `@gmail.com`/`@googlemail.com`, or when the signed `hd` claim names the
 * address's domain (a Workspace account, whose addresses the domain's admin controls). Anything
 * else gets our code, like a typed address. Case-insensitive.
 */
export function providerVouchesForEmail(
  identity: Pick<VerifiedIdentity, "kind" | "email" | "emailVerified">,
  hostedDomain: string | null | undefined,
): boolean {
  const email = identity.email?.trim().toLowerCase();
  if (!email || !identity.emailVerified) return false;
  if (identity.kind !== "google") return true;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (GOOGLE_CONSUMER_DOMAINS.has(domain)) return true;
  const hd = hostedDomain?.trim().toLowerCase();
  return Boolean(hd) && hd === domain;
}
