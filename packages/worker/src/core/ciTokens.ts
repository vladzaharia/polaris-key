/// <reference types="@cloudflare/workers-types" />
/**
 * The `pkeyci_` credential lookup — the seam between the CI route guard and the store.
 *
 * `core/ciScope.ts` `requireCiScope` asks THIS module who a presented `pkeyci_` token belongs to.
 * The store itself — `ci_tokens` (hashed, expiring, revocable), the GitHub OIDC exchange that
 * mints short-lived tokens, and the operator-issued static ones — is `core/publisher.ts`
 * (P2-02, README §3.4 "Publishing"). P2-05's policy suite mocks exactly this module, so it stays
 * a thin re-export with a stable signature.
 */

export type { CiPrincipal } from "./ciVocabulary.js";
export { lookupCiToken } from "./publisher.js";
