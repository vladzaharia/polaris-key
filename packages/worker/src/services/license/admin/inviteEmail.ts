/**
 * LX-27c (plans/LX-27-slices.md §2): the invitation email, a sign-in link and no key, sent to a
 * licence's holder as "<App> via Polaris Locker" through Core's one send choke point.
 *
 * Nothing secret leaves in it: no key, no token, and no address in the link (the address is named
 * in the body only). A send that does not go out never rolls anything back: the answer says
 * `failed`. The copy and the work done are the same whether or not the address has an account, so
 * a create is not an oracle for that (D4).
 */

import { actorColumns, actorOf, appendAudit } from "../../../core/audit.js";
import { ErrorCode } from "../../../core/errors.js";
import { adminJson, err, readBody } from "../../../core/console/respond.js";
import { licenseHolder } from "../../../core/licensing/licenseHolders.js";
import { randomId } from "../../../platform/crypto.js";
import { deliverEmail } from "../../../core/notify/emailDelivery.js";
import {
  licenseInvitationEmail,
  type InviteEmailContext,
} from "../../../core/notify/templates.js";
import { setLicenseInvitedAt } from "../../../core/licensing/store.js";
import { newLicensesAutoLink } from "../../../core/licensing/licenseHolders.js";
import type { LicenseRow } from "../../../core/repo.js";
import type { LicenseAdminContext } from "./index.js";
import {
  emailLinks,
  keyEmailBlocked,
  mailUnavailable,
  productIconUrl,
  SEND_INVITE_ACTION,
  SEND_INVITE_FAILED_ACTION,
  claimSendWindow,
  sendKeyRetryAfter,
  sendWindowRefusal,
  type EmailFailure,
} from "./keyEmail.js";

/** What the answer reports for an invitation: `sent`, or `failed` with the reason. */
export interface InviteEmailResult {
  invite: "sent" | "failed";
  reason?: EmailFailure;
}

/** Why the product cannot invite: Identity is off for the product or not mounted, or auto-link resolves off. */
export type InviteRefusal = "identity_off" | "auto_link_off";

/**
 * Whether an invitation can be useful for this product. Without Identity there is no account to
 * sign in to; with auto-link off (a custom-issuer product) the licence would never join one.
 */
export async function inviteRefusal(
  ctx: LicenseAdminContext,
): Promise<InviteRefusal | null> {
  if (ctx.product.services.identity?.enabled !== true) return "identity_off";
  const on = await newLicensesAutoLink(ctx.db, ctx.product.slug);
  if (on === null) return "identity_off";
  return on ? null : "auto_link_off";
}

/**
 * What the licence list tells the console about invitations (L15): `null` when one can be sent,
 * else why not. `no_mail` is no mail binding or sender: the wizard then offers no invitation
 * that cannot go out. (A create or a resend still answers with the send's own reason.)
 */
export async function invitationsOff(
  ctx: LicenseAdminContext,
): Promise<InviteRefusal | "no_mail" | null> {
  return (
    (await inviteRefusal(ctx)) ?? (mailUnavailable(ctx) ? "no_mail" : null)
  );
}

/**
 * Email the invitation to the licence's address and, when it went out, stamp `invited_at`. Never
 * throws; `failed` carries a `reason`.
 */
export async function emailLicenseInvitation(
  ctx: LicenseAdminContext,
  license: Pick<LicenseRow, "id" | "email" | "name">,
  context: InviteEmailContext = "created",
): Promise<InviteEmailResult> {
  const to = license.email?.trim();
  if (!to) return { invite: "failed", reason: "address_unusable" };
  const blocked = await keyEmailBlocked(ctx, to);
  if (blocked) return { invite: "failed", reason: blocked };
  const { env, db, product, now } = ctx;
  try {
    const { origin, signInUrl, downloadUrl } = await emailLinks(ctx);
    const message = licenseInvitationEmail({
      productName: product.name,
      holderName: license.name,
      address: to,
      signInUrl,
      downloadUrl,
      iconUrl: await productIconUrl(ctx),
      context,
      origin,
    });
    const result = await deliverEmail(
      env,
      db,
      {
        sender: {
          kind: "passthrough",
          product: product.slug,
          displayName: product.name,
        },
        to,
        ...message,
      },
      now,
    );
    if (!result.ok)
      return {
        invite: "failed",
        reason:
          result.reason === "suppressed" ? "suppressed" : "provider_refused",
      };
  } catch {
    return { invite: "failed", reason: "provider_refused" };
  }
  // The mail is out; a failed stamp must not report the send as failed.
  try {
    await setLicenseInvitedAt(db, product.slug, license.id, now);
  } catch {
    // invited_at is display state; the audit row still records the send.
  }
  return { invite: "sent" };
}

/**
 * `POST …/licenses/<id>/send-invite {context?: "assigned"}` (LX-27c.2): mail a fresh invitation to
 * a WAITING licence (assigned, with an email, in no account) and mint nothing. Refused:
 * a floating licence (400, nothing to send to), a licence already in an account (409 `in_account`;
 * its holder is already visible on every read, so this is no new oracle), a disabled or expired one,
 * Identity or auto-link off, and what no retry can fix (no mail binding, an unusable or suppressed
 * address, the daily cap). One mail per licence per 10 minutes, shared with send-key (429
 * `rate_limited`, `retryAfter`). The attempt is audited BEFORE the send and a `.failed` child row
 * frees the window; the audit never carries the address. `invited_at` is stamped only on `sent`.
 */
export async function handleSendInvite(
  ctx: LicenseAdminContext,
  license: LicenseRow,
): Promise<Response> {
  const { req, db, product, session, now } = ctx;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  if ("context" in body && body.context !== "assigned")
    return err(422, ErrorCode.BadRequest, 'context must be "assigned"', {
      fields: ["context"],
    });
  const context: InviteEmailContext =
    body.context === "assigned" ? "assigned" : "resent";
  if ((license.account_id ?? null) !== null)
    return err(
      409,
      ErrorCode.BadRequest,
      "the license is already in an account",
      { reason: "in_account" },
    );
  const to = license.email?.trim();
  if (licenseHolder(license).kind === "floating" || !to)
    return err(
      400,
      ErrorCode.BadRequest,
      "a floating license has no email to send an invitation to; assign it first",
    );
  if (license.status !== "active")
    return err(
      409,
      ErrorCode.BadRequest,
      "enable the license before sending an invitation",
      { reason: "license_not_active" },
    );
  if (license.expires_at !== null && license.expires_at <= now)
    return err(
      409,
      ErrorCode.BadRequest,
      "extend the license before sending an invitation",
      { reason: "license_expired", expiresAt: license.expires_at },
    );
  const refusal = await inviteRefusal(ctx);
  if (refusal)
    return err(409, ErrorCode.BadRequest, "an invitation cannot be sent", {
      reason: refusal,
    });
  const retryAfter = await sendKeyRetryAfter(ctx, license.id);
  if (retryAfter > 0)
    return sendWindowRefusal(
      retryAfter,
      "a key or invitation was sent for this license in the last 10 minutes",
    );
  const blocked = await keyEmailBlocked(ctx, to);
  if (blocked)
    return err(409, ErrorCode.BadRequest, "the invitation cannot be sent", {
      reason: blocked,
    });
  // The attempt is recorded BEFORE the send, by an atomic claim of the window (LX-27c).
  const attemptId = randomId("aud");
  const actor = actorColumns(actorOf(session));
  const claimed = await claimSendWindow(ctx, license.id, {
    id: attemptId,
    ...actor,
    action: SEND_INVITE_ACTION,
    summary: `Sent invitation for ${license.id}`,
  });
  if (!claimed)
    return sendWindowRefusal(
      Math.max(1, await sendKeyRetryAfter(ctx, license.id)),
      "a key or invitation was sent for this license in the last 10 minutes",
    );
  const result = await emailLicenseInvitation(ctx, license, context);
  if (result.invite === "failed")
    await appendAudit(db, {
      product: product.slug,
      at: now,
      ...actor,
      action: SEND_INVITE_FAILED_ACTION,
      target_kind: "license",
      target_id: license.id,
      parent_id: attemptId,
      summary: `Invitation for ${license.id} did not go out (${result.reason ?? "failed"})`,
    });
  return adminJson({
    delivered: {
      invite: result.invite,
      ...(result.reason ? { reason: result.reason } : {}),
    },
  });
}
