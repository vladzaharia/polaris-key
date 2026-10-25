/**
 * The one guard for account self-service (ST-30c.1). A break-glass session names no account
 * (`AdminSession.breakGlass`), so a handler that acts "as me" (my sessions, my tokens, my
 * invitations, anything keyed by `session.aid`) goes through here first.
 */

import { ErrorCode } from "../../core/errors.js";
import { err } from "../../core/console/respond.js";
import type { AdminSession } from "../../core/console/session.js";

/** The account id and the session row a self-service handler may act on. */
export interface AccountSession {
  accountId: string;
  sid: string | undefined;
}

/**
 * The signed-in account, or the response to return. A break-glass session is refused with
 * 403 `forbidden`, reason `break_glass_session`; a session with no account for any other reason
 * (a v1 cookie, a token) with reason `account_session_required`.
 */
export function requireAccountSession(
  session: Pick<AdminSession, "aid" | "sid" | "breakGlass">,
): AccountSession | Response {
  if (session.breakGlass === true)
    return err(
      403,
      ErrorCode.Forbidden,
      "Emergency sign-in has no account. Sign in normally to do this.",
      { reason: "break_glass_session" },
    );
  if (!session.aid)
    return err(403, ErrorCode.Forbidden, "Sign in again to do this.", {
      reason: "account_session_required",
    });
  return { accountId: session.aid, sid: session.sid };
}

/**
 * ST-30c.2 (N3): a break-glass session may not mint a credential that outlives the emergency
 * hour (admin API, personal, registry, service and CI tokens). Revocation stays allowed. Returns
 * the 403 `forbidden` / `break_glass_session` refusal, or null for every other session.
 */
export function refuseBreakGlass(
  session: Pick<AdminSession, "breakGlass">,
): Response | null {
  if (session.breakGlass !== true) return null;
  return err(
    403,
    ErrorCode.Forbidden,
    "Emergency sign-in can’t create tokens. Sign in with your account to do this.",
    { reason: "break_glass_session" },
  );
}
