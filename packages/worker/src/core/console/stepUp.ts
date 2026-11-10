/** The step-up gate a handler applies when the need depends on the request body. */

import { STEP_UP_MAX_AGE_SECONDS, isSteppedUp } from "./session.js";
import type { AdminSession } from "./session.js";
import { err } from "./respond.js";

/** A 403 `step_up_required` when the session has no recent proven re-authentication, else null. */
export function requireStepUp(
  session: AdminSession,
  now: number,
): Response | null {
  if (isSteppedUp(session, now)) return null;
  return err(
    403,
    "step_up_required",
    "Sign in again to confirm it's you. This needs a sign-in from the last 5 minutes.",
    { maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS },
  );
}
