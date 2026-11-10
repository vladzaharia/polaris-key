/**
 * The consent view of a registered client's request (I-21.8; V5 §12.13.3, §12.13.6): what the
 * client gets if the person continues, built from the stored client and request, never a query.
 * `items` are, in order and each only when requested, `profile` (the claims the scopes deliver,
 * with the ones that have no switch in `required`), `entitlements` and `offline`. No licence line
 * and no Cloud Sync line, ever. `scopeHash` is §12.7.3's function over the claims shown and the
 * `pkey:*` and `offline_access` lines. `firstTime` and `changed` compare the client grant; `reauth`
 * says the card must sign the person in again before Continue.
 */

import type {
  AppConsentView,
  ConsentItem,
} from "@polaris-key/protocol/identity";
import type { ClientRecord } from "./clientsRepo.js";
import {
  claimsForCode,
  claimsOfScopes,
  claimsToAsk,
  grantCovers,
} from "./coverage.js";
import type { ClientGrant } from "./grantsRepo.js";

export function registeredConsentItems(
  client: Pick<ClientRecord, "claims">,
  scope: readonly string[],
  grant: ClientGrant | null,
  reask: boolean,
): ConsentItem[] {
  const reached = claimsOfScopes(scope);
  const claims = claimsToAsk(reached, grant, reask, client.claims.required);
  const asked = (line: string): boolean =>
    scope.includes(line) && (reask || !grant || !grant.scopes.includes(line));
  const items: ConsentItem[] = [];
  if (claims.length > 0)
    items.push({
      kind: "profile",
      claims,
      required: client.claims.required.filter((c) => claims.includes(c)),
      ...(reask && grant
        ? { off: claims.filter((c) => grant.claimsDeclined.includes(c)) }
        : {}),
    });
  if (asked("pkey:entitlements")) items.push({ kind: "entitlements" });
  if (asked("offline_access")) items.push({ kind: "offline" });
  return items;
}

export function registeredConsentView(input: {
  handle: string;
  person: AppConsentView["person"];
  client: Pick<ClientRecord, "claims">;
  scope: readonly string[];
  scopeHash: string;
  grant: ClientGrant | null;
  reauth: boolean;
  /** `prompt=consent`: ask about everything again, starting each switch from the grant. */
  reask: boolean;
  wrongAccount: boolean;
  terms: AppConsentView["terms"] | null;
}): AppConsentView {
  const { client, scope, grant } = input;
  const items = registeredConsentItems(client, scope, grant, input.reask);
  // What the client already gets and the card does not list again (a re-ask lists it with its switch).
  const listed = items.flatMap((i) => (i.kind === "profile" ? i.claims : []));
  const shared = grant
    ? claimsForCode(grant, scope).filter((c) => !listed.includes(c))
    : [];
  return {
    request: input.handle,
    person: input.person,
    items,
    scopeHash: input.scopeHash,
    firstTime: grant === null,
    changed:
      grant !== null && !grantCovers(grant, scope, client.claims.required),
    ...(input.reauth ? { reauth: true as const } : {}),
    ...(input.wrongAccount ? { wrongAccount: true as const } : {}),
    ...(shared.length > 0 ? { shared } : {}),
    ...(input.terms ? { terms: input.terms } : {}),
  };
}
