/**
 * LX-27c (plans/LX-27-slices.md §2): the invitation email, a sign-in link and no key, sent to a
 * licence's holder as "<App> via Polaris Locker" through Core's one send choke point.
 *
 * Nothing secret leaves in it: no key, no token, and no address in the link (the address is named
 * in the body only). A send that does not go out never rolls anything back: the answer says
 * `failed`. The copy and the work done are the same whether or not the address has an account, so
 * a create is not an oracle for that (D4).
 */

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
  productIconUrl,
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
