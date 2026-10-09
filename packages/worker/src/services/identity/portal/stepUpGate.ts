/**
 * The portal's step-up gate for irreversible or
 * credential-minting self-service actions: erase the account, remove a licence from the
 * library, mint a registry token. The session must have been signed in within
 * `STEP_UP_MAX_AGE_SECONDS`; an older 14-day cookie answers 401 `step_up_required`, the same
 * shape "Get a new key" uses, and the page asks the person to sign in again.
 */

import { STEP_UP_MAX_AGE_SECONDS, isFresh } from "../accounts/links.js";
import { portalJson } from "./api.js";
import { portalSessionAuthenticatedAt, type PortalSession } from "./session.js";

export function portalStepUpGate(
  session: PortalSession,
  now: number,
): Response | null {
  if (
    isFresh(
      {
        accountId: session.accountId,
        authenticatedAt: portalSessionAuthenticatedAt(session),
      },
      now,
    )
  )
    return null;
  return portalJson(
    {
      error: "step_up_required",
      message: "sign in again to confirm it's you",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    },
    401,
  );
}
