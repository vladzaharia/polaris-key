/**
 * The signed-in operator's own sign-in methods (ST-30c.3; ST-28 SM-3(a) and (d)):
 *
 *   GET  /me/methods               each method: kind, name, created, last used, `strong`, and
 *                                  `consoleEligible` (a passkey enrolled under the console's RP id)
 *   POST /me/passkeys/options      a registration challenge (I-16), step-up
 *   POST /me/passkeys              the attestation (I-16), step-up; the new passkey is strong
 *   POST /me/methods/:id/strong    "Use for the console": mark one of MY passkeys strong, step-up
 *
 * Area `console`, session only: a break-glass session has no account (403 `break_glass_session`),
 * and the rows name no `tokenScope`, so a token is refused before this runs. The passkey routes
 * delegate to Identity (`consolePasskeyCeremony`), which hands I-16 the session's step-up time as
 * the caller's `authenticatedAt` and nothing else, so I-16's own freshness check stands behind the
 * route table's. Removal stays in the Locker account (SM-5 needs no strong session).
 *
 * Every strong-marking writes `rbac.method_strong` to `platform_audit` (actor: the member id) and
 * mails the account and every Superadmin. A passkey added in the portal is never strong (SM-4).
 */

import { platformAudit } from "../../core/audit.js";
import { ErrorCode } from "../../core/errors.js";
import { adminJson, err, notFound } from "../../core/console/respond.js";
import { isSteppedUp } from "../../core/console/session.js";
import { consoleMethodStrongNotice } from "../../core/notify/templates.js";
import {
  consolePasskeyCeremony,
  consoleRpId,
  consoleVerifiedPrimaryEmail,
  listConsoleMethods,
  markConsoleMethodStrong,
} from "../../services/identity/public.js";
import { requireAccountSession } from "../lib/accountSession.js";
import { notifySuperadmins, NOTICE_CAP } from "../lib/operatorNotices.js";
import { sendOperatorNotice } from "./accessShared.js";
import type { AdminCtx } from "../routes.js";

/** The account, its session row and the console's RP id, or the refusal to return. */
function context(c: AdminCtx):
  | {
      accountId: string;
      sid: string;
      rpId: string;
    }
  | Response {
  const who = requireAccountSession(c.session);
  if (who instanceof Response) return who;
  if (!who.sid)
    return err(403, ErrorCode.Forbidden, "Sign in again to do this.", {
      reason: "account_session_required",
    });
  const rpId = consoleRpId(c.env, c.req);
  if (!rpId) return notFound();
  return { accountId: who.accountId, sid: who.sid, rpId };
}

/** The mails of one strong-marking: the account itself, then every Superadmin. */
async function announce(c: AdminCtx, accountId: string): Promise<void> {
  const actor = c.session.name || c.session.email;
  const mails = { left: NOTICE_CAP };
  try {
    const to = await consoleVerifiedPrimaryEmail(c.db, accountId);
    if (to) {
      await sendOperatorNotice(
        c.env,
        c.db,
        to,
        consoleMethodStrongNotice({
          actor,
          at: c.now,
          audience: "self",
          origin: c.env.CONSOLE_ORIGIN,
        }),
        c.now,
        true,
      );
    }
  } catch {
    // A notice that fails never undoes the change.
  }
  await notifySuperadmins(
    c.env,
    c.db,
    c.now,
    consoleMethodStrongNotice({
      actor,
      at: c.now,
      audience: "superadmin",
      origin: c.env.CONSOLE_ORIGIN,
    }),
    mails,
    true,
  );
}

async function audited(
  c: AdminCtx,
  linkId: string,
  how: "enrolled" | "marked",
): Promise<void> {
  await platformAudit(
    c.db,
    c.session,
    c.now,
    "rbac.method_strong",
    { kind: "link", id: linkId },
    how === "enrolled"
      ? "Enrolled a passkey that opens the console"
      : "Set a passkey to open the console",
  );
}

/** `GET /me/methods`. */
export async function handleMyMethods(c: AdminCtx): Promise<Response> {
  const ctx = context(c);
  if (ctx instanceof Response) return ctx;
  return adminJson({
    methods: await listConsoleMethods(c.db, ctx.accountId, ctx.rpId),
  });
}

async function ceremony(
  c: AdminCtx,
  rest: readonly ["options"] | readonly [],
): Promise<Response> {
  const ctx = context(c);
  if (ctx instanceof Response) return ctx;
  const { response, strongLinkId } = await consolePasskeyCeremony(
    c.req,
    c.env,
    c.db,
    {
      accountId: ctx.accountId,
      sid: ctx.sid,
      // Only a step-up inside the window counts; anything else is the epoch, which I-16 refuses.
      stepUpAt: isSteppedUp(c.session, c.now) ? c.session.stepUpAt : undefined,
    },
    rest,
    c.now,
  );
  if (strongLinkId) {
    await audited(c, strongLinkId, "enrolled");
    await announce(c, ctx.accountId);
  }
  return response;
}

/** `POST /me/passkeys/options`. */
export const handleMyPasskeyOptions = (c: AdminCtx): Promise<Response> =>
  ceremony(c, ["options"]);

/** `POST /me/passkeys`. */
export const handleMyPasskeyAdd = (c: AdminCtx): Promise<Response> =>
  ceremony(c, []);

/** `POST /me/methods/:id/strong`. */
export async function handleMyMethodStrong(c: AdminCtx): Promise<Response> {
  const ctx = context(c);
  if (ctx instanceof Response) return ctx;
  const linkId = c.params.id ?? "";
  const result = await markConsoleMethodStrong(
    c.db,
    ctx.accountId,
    linkId,
    ctx.rpId,
    c.now,
  );
  if (result.status === "not_found") return notFound();
  if (result.status === "not_eligible")
    return err(
      403,
      ErrorCode.Forbidden,
      "Only a passkey saved for this site can open it.",
      { reason: "not_eligible" },
    );
  if (result.status === "already_strong")
    return err(
      409,
      ErrorCode.Forbidden,
      "That passkey can already sign in here.",
      {
        reason: "already_strong",
      },
    );
  await audited(c, linkId, "marked");
  await announce(c, ctx.accountId);
  return adminJson({ ok: true, id: linkId, strong: true });
}
