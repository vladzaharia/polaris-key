/**
 * I-07: a portal session the way a sign-in opens one: a live `account_sessions` row and the
 * signed cookie that names it (`startAccountSession`). Same return shape as `issuePortalSession`
 * (`{ token, session }`), so a test that minted a bare signed cookie before server-side sessions
 * existed swaps the call, not its assertions. A bare signed cookie (no row) is refused now.
 */
import type { Env } from "../src/platform/env.js";
import type { Db } from "../src/db/types.js";
import { startAccountSession } from "../src/services/identity/portal/accountSessions.js";
import {
  PORTAL_COOKIE,
  type PortalSession,
  type PortalSessionIdentity,
} from "../src/services/identity/portal/session.js";

export async function issuePortalSessionRow(
  env: Env,
  db: Db,
  identity: PortalSessionIdentity,
  now: number,
  amr: readonly string[] = ["email"],
): Promise<{ token: string; session: PortalSession }> {
  const { cookie, session } = await startAccountSession(
    env,
    db,
    {
      account: {
        id: identity.accountId,
        display_name: identity.name ?? null,
        primary_email: identity.email ?? null,
      },
      amr,
    },
    now,
  );
  const pair = cookie.split(";")[0]!;
  return { token: pair.slice(PORTAL_COOKIE.length + 1), session };
}
