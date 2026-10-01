/// <reference types="@cloudflare/workers-types" />
/**
 * The `pkeyci_` credential lookup — the seam P2-02 fills.
 *
 * P2-05's CI routes (promote, pin, unpin, yank) authenticate a CI job through
 * `core/ciScope.ts` `requireCiScope`, which asks THIS function who a presented `pkeyci_` token
 * belongs to. The credential store itself — `ci_tokens` (hashed, expiring, revocable), the
 * GitHub OIDC exchange that mints short-lived tokens, and the operator-issued static ones — is
 * P2-02's (`core/publisher.ts`, README §3.4 "Publishing"). Until it lands there is no way to
 * hold a `pkeyci_` token, so every lookup answers "unknown token" and the CI routes refuse
 * every request with 401. That is the fail-closed reading of "no credential store yet", not a
 * stub that lets anything through.
 *
 * P2-02 replaces the body (or re-exports its own implementation from here) and keeps the
 * signature: `requireCiScope` and its tests depend on nothing else.
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";

/** Who a valid `pkeyci_` token belongs to. */
export interface CiPrincipal {
  /** The product the token was issued for. A token is never valid for another product. */
  readonly product: string;
  /** The audit actor's subject: the OIDC `sub` / workflow ref, or the static token's id. */
  readonly subject: string;
  /** Granted scopes (`release:publish`, `release:promote`, `release:yank`, …). */
  readonly scopes: readonly string[];
}

/**
 * Look a presented `pkeyci_` token up. `null` for an unknown, expired or revoked token.
 * No credential store exists before P2-02, so nothing is known yet.
 */
export async function lookupCiToken(
  _env: Env,
  _db: Db,
  _token: string,
  _now: number,
): Promise<CiPrincipal | null> {
  return null;
}
