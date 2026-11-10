/**
 * Which claims and lines a registered client's request reaches, and whether a client grant covers
 * it (I-21.6 and I-21.7; V5 §12.13.3, §12.13.6; decision D4).
 *
 * `profile` delivers `name` and `picture`, `email` delivers `email`. A claim in the client's
 * `claims.required` has no switch: it must be GRANTED. Any other requested claim is optional and
 * only has to be DECIDED, granted or declined (an optional claim declined before is not asked
 * again). `pkey:entitlements` and `offline_access` are lines with no switch, granted by Continue:
 * the grant must hold them. A grant covers the request when every such item was decided in it.
 * `prompt=consent` asks again anyway (the caller's rule, not this function's).
 */

import type { IssuerClaim } from "@polaris-key/protocol/identity";
import type { ClientGrant } from "./grantsRepo.js";

/** The claims the scopes deliver, in ConsentStep's order. */
export function claimsOfScopes(scopes: readonly string[]): IssuerClaim[] {
  const out: IssuerClaim[] = [];
  if (scopes.includes("profile")) out.push("name", "picture");
  if (scopes.includes("email")) out.push("email");
  return out;
}

/** The two scopes that are consent lines, not claims. */
export function lineScopes(scopes: readonly string[]): string[] {
  return scopes.filter(
    (s) => s === "pkey:entitlements" || s === "offline_access",
  );
}

/** The claims a code carries: the granted ones that the request reaches. */
export function claimsForCode(
  grant: ClientGrant,
  scopes: readonly string[],
): IssuerClaim[] {
  const reached = claimsOfScopes(scopes);
  return grant.claimsGranted.filter((c) => reached.includes(c));
}

/** Does `grant` cover a request for `scopes` from a client that requires `required`? */
export function grantCovers(
  grant: ClientGrant | null,
  scopes: readonly string[],
  required: readonly IssuerClaim[],
): boolean {
  if (!grant) return false;
  const reached = claimsOfScopes(scopes);
  for (const c of reached) {
    if (required.includes(c)) {
      if (!grant.claimsGranted.includes(c)) return false;
    } else if (
      !grant.claimsGranted.includes(c) &&
      !grant.claimsDeclined.includes(c)
    )
      return false;
  }
  return lineScopes(scopes).every((s) => grant.scopes.includes(s));
}

/**
 * The claims a Continue body grants: `consent.claims` read against `reached` (what the request can
 * deliver). Absent `consent` grants all of `reached`. `null` when it is malformed or names something
 * `reached` does not hold.
 */
export function claimsFromConsent<T extends string>(
  body: Record<string, unknown>,
  reached: readonly T[],
): T[] | null {
  if (body.consent === undefined) return [...reached];
  const claims = (body.consent as { claims?: unknown } | null)?.claims;
  if (
    !Array.isArray(claims) ||
    !claims.every((c) => typeof c === "string" && reached.some((r) => r === c))
  )
    return null;
  return reached.filter((c) => claims.includes(c));
}

/**
 * The claims a request asks about NOW: every one it reaches when the person has no grant, or when
 * `prompt=consent` asks again; otherwise only the undecided ones. A claim the person declined stays
 * declined and is never asked again (V5 §12.13.6; I-34 is where they change it).
 */
export function claimsToAsk(
  reached: readonly IssuerClaim[],
  grant: ClientGrant | null,
  reask: boolean,
): IssuerClaim[] {
  if (!grant || reask) return [...reached];
  return reached.filter(
    (c) =>
      !grant.claimsGranted.includes(c) && !grant.claimsDeclined.includes(c),
  );
}
