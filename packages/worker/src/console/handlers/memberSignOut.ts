/**
 * "Sign out everywhere" for one console member (ST-34.12):
 *
 *   GET  /members/<memberId>/sign-out   the dry run: the admin tokens that would stop
 *   POST /members/<memberId>/sign-out   do it
 *
 * Platform scope, area `members`, level `edit` on both (the preview names token labels, so a
 * read-only member does not see it). No step-up: it only narrows (G4). Session only.
 *
 * What a POST ends: every live `account_sessions` row of the account (through Identity); the
 * operator's cookies, by the same `admin-revoked` mark a sign-out writes, keyed by the member id and by each IdP
 * subject of the member's console links (a break-glass session carries the subject);
 * and the account's `admin`-scope personal tokens, at once. `packages`-scope tokens are not
 * touched. The change is audited as `rbac.signout` and the member is told by mail.
 *
 * Who may: the caller must be allowed to take back every grant the target holds (`mayRevoke`),
 * and a holder of the root rule is signed out by a Superadmin alone. A member cannot sign
 * themselves out here (the ordinary sign-out is for that). An unknown, stale or forged id is a 404
 * that says nothing else; no body names an account id.
 */

import { platformAudit } from "../../core/audit.js";
import { ErrorCode } from "../../core/errors.js";
import { adminJson, err } from "../../core/console/respond.js";
import { isMemberId } from "../../core/console/memberId.js";
import { revokeAdminSessions } from "../../core/console/sessionRevocation.js";
import {
  listAccountTokens,
  revokeAllAccountTokens,
  ADMIN_SCOPE,
} from "../../core/accounts/personalTokens.js";
import { memberSignedOutNotice } from "../../core/notify/templates.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import { listAccountGrants } from "../../core/rbac/bindings.js";
import { isSuperadmin } from "../../core/rbac/can.js";
import { mayRevoke } from "../../core/rbac/grantRules.js";
import {
  consoleIdpSubjectsForAccount,
  consoleRootHolders,
  endConsoleSessionsForAccount,
} from "../../services/identity/public.js";
import { requireAccountSession } from "../lib/accountSession.js";
import type { AdminCtx } from "../routes.js";
import { sendOperatorNotice } from "./accessShared.js";
import { resolveMember } from "./bindings.js";

/** The same write budget as a grant change: sign-out is an access change. */
const WRITE_LIMIT = 30;
const WRITE_WINDOW_SECONDS = 300;

interface Target {
  accountId: string;
  memberId: string;
  name: string;
  email: string;
}

const refused = (reason: string, message: string) =>
  err(403, ErrorCode.Forbidden, message, { reason });

/** The member a route names, if the caller may sign them out; else the response to return. */
async function targetOf(c: AdminCtx): Promise<Target | Response> {
  const memberId = c.params.memberId ?? "";
  // The same answer as `resolveMember` gives an id that matches no one.
  if (!isMemberId(memberId))
    return err(404, ErrorCode.NotFound, "no such member", {
      reason: "no_such_member",
    });
  const acct = requireAccountSession(c.session);
  if (acct instanceof Response) return acct;
  const found = await resolveMember(c, memberId);
  if (found instanceof Response) return found;
  const { accountId, entry } = found;
  if (
    accountId === acct.accountId ||
    memberId === c.session.principal?.memberId
  )
    return refused("self_sign_out", "Use Sign out to end your own sessions.");
  const principal = c.session.principal;
  // The root rule is no stored grant: only a Superadmin may touch a holder of it.
  const roots = await consoleRootHolders(c.env, c.db, c.now);
  if (roots.includes(accountId) && !isSuperadmin(principal))
    return refused("grant_refused", "You can't sign this member out.");
  for (const g of await listAccountGrants(c.db, accountId))
    if (!mayRevoke(principal, { role: g.role, scope: g.scope, areas: g.areas }))
      return refused("grant_refused", "You can't sign this member out.");
  return { accountId, memberId, name: entry.name, email: entry.email };
}

/** The member's live admin tokens, by label and last use; never an id, hint or token. */
async function liveAdminTokens(c: AdminCtx, accountId: string) {
  return (await listAccountTokens(c.db, accountId, c.now))
    .filter((t) => t.scope === ADMIN_SCOPE && t.status === "active")
    .map((t) => ({
      label: t.label,
      lastUsedAt: t.lastUsedAt,
      expiresAt: t.expiresAt,
    }));
}

/** `GET /members/<memberId>/sign-out`: what a POST would stop. Writes nothing. */
export async function handleMemberSignOutPreview(
  c: AdminCtx,
): Promise<Response> {
  const t = await targetOf(c);
  if (t instanceof Response) return t;
  return adminJson({
    memberId: t.memberId,
    tokens: await liveAdminTokens(c, t.accountId),
  });
}

/** `POST /members/<memberId>/sign-out`. */
export async function handleMemberSignOut(c: AdminCtx): Promise<Response> {
  const writer = c.session.principal?.memberId ?? "";
  const within = await rateLimitOk(
    c.env,
    "_admin",
    {
      bucket: "adminGrantWrite",
      id: writer,
      limit: WRITE_LIMIT,
      windowSec: WRITE_WINDOW_SECONDS,
    },
    c.now,
  );
  if (!within)
    return err(429, "rate_limited", "too many access changes; try again later");
  const t = await targetOf(c);
  if (t instanceof Response) return t;

  const tokens = await liveAdminTokens(c, t.accountId);
  // The mark first: if the store cannot be reached nothing else has changed, and the caller retries.
  try {
    await revokeAdminSessions(c.env, t.memberId, c.now);
    // A break-glass session has no account; its `sub` is the member's IdP subject. Mark each link.
    for (const sub of await consoleIdpSubjectsForAccount(
      c.env,
      c.db,
      t.accountId,
    ))
      await revokeAdminSessions(c.env, sub, c.now);
  } catch {
    return err(503, "unavailable", "try again in a moment");
  }
  const sessions = await endConsoleSessionsForAccount(c.db, t.accountId, c.now);
  const stopped = await revokeAllAccountTokens(
    c.db,
    t.accountId,
    writer,
    "access_removed",
    c.now,
    ADMIN_SCOPE,
  );
  await platformAudit(
    c.db,
    c.session,
    c.now,
    "rbac.signout",
    { kind: "console_member", id: t.memberId },
    `Signed ${t.memberId} out everywhere`,
    { after: { sessions, adminTokens: stopped } },
  );
  let notified = false;
  try {
    if (t.email.trim())
      notified = await sendOperatorNotice(
        c.env,
        c.db,
        t.email.trim(),
        memberSignedOutNotice({
          name: t.name || t.email,
          by: c.session.name || c.session.email,
          tokens: stopped,
          origin: c.env.CONSOLE_ORIGIN,
        }),
        c.now,
        true,
      );
  } catch {
    notified = false;
  }
  return adminJson({
    ok: true,
    memberId: t.memberId,
    sessions,
    tokens,
    notified,
  });
}
