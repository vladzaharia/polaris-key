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
import { claimsOfScopes, grantCovers } from "./coverage.js";
import type { ClientGrant } from "./grantsRepo.js";

export function registeredConsentItems(
  client: Pick<ClientRecord, "claims">,
  scope: readonly string[],
): ConsentItem[] {
  const claims = claimsOfScopes(scope);
  const items: ConsentItem[] = [];
  if (claims.length > 0)
    items.push({
      kind: "profile",
      claims: [...claims],
      required: client.claims.required.filter((c) => claims.includes(c)),
    });
  if (scope.includes("pkey:entitlements")) items.push({ kind: "entitlements" });
  if (scope.includes("offline_access")) items.push({ kind: "offline" });
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
}): AppConsentView {
  const { client, scope, grant } = input;
  return {
    request: input.handle,
    person: input.person,
    items: registeredConsentItems(client, scope),
    scopeHash: input.scopeHash,
    firstTime: grant === null,
    changed:
      grant !== null && !grantCovers(grant, scope, client.claims.required),
    ...(input.reauth ? { reauth: true as const } : {}),
  };
}
