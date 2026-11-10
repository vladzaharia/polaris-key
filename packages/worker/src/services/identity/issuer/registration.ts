/**
 * Is what a stored request, code or refresh family was issued for still registered? (V5 §12.13.4,
 * §12.13.7; I-21.10.) The developer may edit a client between `authorize` and the end of a family:
 * a redirect URI that is no longer one of its registered URIs, or a scope it may no longer be
 * granted, ends the use at once (Continue answers the same 404 as an unknown handle, `token` answers
 * `invalid_grant`). The redirect is matched as at `authorize` (exact, the loopback port aside).
 */

import type { ClientRecord } from "./clientsRepo.js";
import { matchRedirectUri } from "./redirect.js";

export function stillRegistered(
  client: Pick<ClientRecord, "scopes" | "redirectUris" | "type">,
  redirectUri: string | null,
  scope: readonly string[],
): boolean {
  if (!scope.every((s) => client.scopes.some((c) => c === s))) return false;
  return (
    redirectUri === null ||
    matchRedirectUri(client.redirectUris, redirectUri, client.type) !== null
  );
}
