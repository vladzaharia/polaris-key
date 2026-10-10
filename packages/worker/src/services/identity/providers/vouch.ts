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
import {
  emailDomain,
  type Connection,
} from "../../../core/oidc/connections.js";

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

/**
 * The narrowed rule for a connection's `email_verified` (I-30; plans/I-27.md §2.3 "Trust in
 * `email_verified`"). Used only by `beginProviderSignIn` on the gate paths: the card's connection
 * buttons and routing, and the rewritten `/callback`. The legacy product engine keeps
 * `providerVouchesForEmail` until I-32b.
 *
 *   - A PLATFORM connection vouches only for an address inside one of its DNS-verified domains,
 *     exactly (`example.com` never covers `sub.example.com`), and only when the ID token said
 *     `email_verified` and the address is plain ASCII before it is lower-cased (a lookalike such
 *     as the Kelvin sign would otherwise fold onto a verified domain).
 *   - A PRODUCT connection never vouches: its addresses get the email gate's code (I-32).
 *   - A disabled connection vouches for nothing.
 *
 * `verifiedDomains` is the connection's verified list as `verifiedDomains()` reads it; an
 * unverified domain is simply not in it, so it never vouches.
 */
export function connectionVouchesForEmail(
  connection: Pick<Connection, "scope" | "status">,
  identity: Pick<VerifiedIdentity, "email" | "emailVerified">,
  verifiedDomains: readonly string[],
): boolean {
  if (connection.status !== "active") return false;
  if (connection.scope !== "platform") return false;
  if (!identity.emailVerified) return false;
  const raw = identity.email?.trim() ?? "";
  // The whole address, plain ASCII, before anything lower-cases it.
  if (!/^[\x21-\x7e]+$/.test(raw)) return false;
  const domain = emailDomain(raw);
  if (!domain) return false;
  return verifiedDomains.includes(domain);
}
