/// <reference types="@cloudflare/workers-types" />
/**
 * Scope checks for CI-authenticated routes (P2-05; the token store is P2-02's `core/publisher.ts`).
 *
 * A CI job presents `Authorization: Bearer pkeyci_…`. The answer is one of:
 *
 *   401 unauthorized  no `pkeyci_` bearer, or one `lookupCiToken` does not know, or one issued
 *                     for a different product (indistinguishable from unknown, so a token
 *                     cannot be used to probe which products exist);
 *   403 forbidden     a valid token for this product that lacks the scope, with
 *                     `reason: "missing_scope"` and the scope it needed;
 *   the principal     otherwise — the caller audits its `subject` as `ci:<subject>`.
 *
 * Bodies are the platform's flat error shape with a machine-readable `reason` (P2-02 design
 * note: no new `PolarisErrorCode`, which would be a `shared-protocol` change).
 */

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { bearer } from "../http.js";
import { errorResponse, ErrorCode } from "./errors.js";
import { lookupCiToken } from "./ciTokens.js";
import {
  CI_TOKEN_PREFIX,
  type CiPrincipal,
  type CiScope,
} from "./ciVocabulary.js";

export type { CiPrincipal, CiScope } from "./ciVocabulary.js";
export { CI_SCOPES, CI_TOKEN_PREFIX } from "./ciVocabulary.js";

/** The audit actor for a CI principal (`modified_by`, `audit.actor_sub`). */
export function ciActor(principal: CiPrincipal): string {
  return `ci:${principal.subject}`;
}

/**
 * Authenticate a CI request for `product` and require `scope`. Returns the principal, or the
 * refusal to send.
 */
export async function requireCiScope(
  req: Request,
  env: Env,
  db: Db,
  product: string,
  scope: CiScope,
  now: number,
): Promise<CiPrincipal | Response> {
  const token = bearer(req);
  if (!token || !token.startsWith(CI_TOKEN_PREFIX)) {
    return errorResponse(
      401,
      ErrorCode.Unauthorized,
      "a pkeyci_ token is required",
      {
        reason: "ci_token_required",
      },
    );
  }
  const principal = await lookupCiToken(env, db, token, now);
  if (!principal || principal.product !== product) {
    return errorResponse(
      401,
      ErrorCode.Unauthorized,
      "unknown, expired or revoked CI token",
      {
        reason: "invalid_ci_token",
      },
    );
  }
  if (!principal.scopes.includes(scope)) {
    return errorResponse(
      403,
      ErrorCode.Forbidden,
      `this token lacks the ${scope} scope`,
      {
        reason: "missing_scope",
        scope,
      },
    );
  }
  return principal;
}
