/**
 * LX-27 (S-24 §8.4, D11/D12): emailing a licence key to the licence's holder. Used by the create
 * route (`delivery.email`) and by `POST …/licenses/<id>/send-key`.
 *
 * The key leaves only in the email body (sent as "<App> via Polaris Key", I-18's passthrough
 * sender, through Core's one send choke point) and in the response of the request that minted it.
 * It is never in a log, an audit summary or the subject. A send that does not go out never rolls
 * anything back: the answer says `failed` and the operator tries again through send-key.
 */

import { actorColumns, actorOf, appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import {
  firstHostedImage,
  hostedImageOrigin,
  hostedImages,
  hostedImageUrl,
  PRESENTATION_ICON_SLOTS,
} from "../../../core/assets/hostedImages.js";
import { ErrorCode } from "../../../core/errors.js";
import { hashKey, mintLicenseKey } from "../../../platform/crypto.js";
import {
  replaceLicenseKeys,
  insertKey,
} from "../../../core/licensing/store.js";
import { adminJson, err, readBody } from "../../../core/console/respond.js";
import { licenseHolder } from "../../../core/licensing/licenseHolders.js";
import {
  applePrivateRelayRegistered,
  deliverEmail,
  emailSuppressed,
  isApplePrivateRelay,
  productEmailCapOk,
} from "../../../core/notify/emailDelivery.js";
import { passthroughSender } from "../../../core/notify/emailSender.js";
import { strictEmail } from "../../../core/strictEmail.js";
import {
  appLink,
  licenseKeyEmail,
  type KeyEmailContext,
} from "../../../core/notify/templates.js";
import {
  portalEnabled,
  portalOriginOf,
} from "../../../core/licensing/manageUrl.js";
import type { LicenseRow } from "../../../core/repo.js";
import type { LicenseAdminContext } from "./index.js";

/** What the answer reports for the email: `queued` is reserved for a deferred transport. */
export type EmailDelivered = "sent" | "queued" | "failed";
/** Why a send did not go out: what the console words, and whether a retry could help. */
export type EmailFailure =
  /** No binding or no usable sender: deployment-wide. */
  | "no_mail_binding"
  /** The address is malformed, or an Apple relay the sender is not registered with. */
  | "address_unusable"
  | "suppressed"
  /** The product's daily email cap is spent. */
  | "daily_cap"
  /** The provider refused or was down: a retry may work. */
  | "provider_refused";
/** Reasons a retry cannot fix (the console hides Try again). */
export const PERMANENT_EMAIL_FAILURES: readonly EmailFailure[] = [
  "no_mail_binding",
  "address_unusable",
  "suppressed",
  "daily_cap",
];
export interface KeyEmailResult {
  email: EmailDelivered;
  reason?: EmailFailure;
}

/** Label of a key minted by send-key. */
export const SENT_KEY_LABEL = "Sent by email";
/** One send-key per licence in this many seconds. */
export const SEND_KEY_WINDOW_SECONDS = 600;
/** The audit actions: the attempt, and its failure (a row whose `parent_id` is the attempt's). */
export const SEND_KEY_ACTION = "license.key.send";
export const SEND_KEY_FAILED_ACTION = "license.key.send.failed";

/** The product's hosted icon for the email's hero, or null. */
async function productIconUrl(
  ctx: LicenseAdminContext,
): Promise<string | null> {
  try {
    if ((await hostedImageOrigin(ctx.env, ctx.db)) === null) return null;
    const icon = firstHostedImage(
      await hostedImages(
        ctx.env,
        ctx.db,
        ctx.product.slug,
        PRESENTATION_ICON_SLOTS,
      ),
      PRESENTATION_ICON_SLOTS,
    );
    return icon ? hostedImageUrl(ctx.env, ctx.product.slug, icon, 128) : null;
  } catch {
    return null;
  }
}

/**
 * Refuse BEFORE minting what no retry can fix: no mail binding or sender, an unusable address,
 * a suppressed recipient, the product's spent daily cap. Answers the reason, or null when a send
 * may be tried.
 */
export async function keyEmailBlocked(
  ctx: LicenseAdminContext,
  to: string,
): Promise<EmailFailure | null> {
  const { env, db, product, now } = ctx;
  if (!env.EMAIL || !passthroughSender(env, product.name, product.slug))
    return "no_mail_binding";
  if (
    strictEmail(to) === null ||
    (isApplePrivateRelay(to) && !applePrivateRelayRegistered(env))
  )
    return "address_unusable";
  try {
    if (await emailSuppressed(env, db, to, now)) return "suppressed";
  } catch {
    // An unreadable list fails closed inside deliverEmail; do not block on it here.
  }
  if (!(await productEmailCapOk(env, db, product.slug, now, true)))
    return "daily_cap";
  return null;
}

/**
 * Email `key` to the licence's address. Never throws; `failed` carries a `reason`.
 */
export async function emailLicenseKey(
  ctx: LicenseAdminContext,
  license: Pick<LicenseRow, "email" | "name">,
  key: string,
  context: KeyEmailContext = "created",
): Promise<KeyEmailResult> {
  const to = license.email?.trim();
  if (!to) return { email: "failed", reason: "address_unusable" };
  const blocked = await keyEmailBlocked(ctx, to);
  if (blocked) return { email: "failed", reason: blocked };
  const { env, db, product, req, now } = ctx;
  try {
    const origin = portalOriginOf(env, req) ?? new URL(req.url).origin;
    const download =
      ctx.hooks.releaseCatalog() !== null &&
      (await portalEnabled(db, product.slug))
        ? appLink(origin, `p/${encodeURIComponent(product.slug)}/download`)
        : null;
    const message = licenseKeyEmail({
      productName: product.name,
      holderName: license.name,
      key,
      signInUrl: `${origin}/signin?product=${encodeURIComponent(product.slug)}`,
      downloadUrl: download,
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
    if (result.ok) return { email: "sent" };
    return {
      email: "failed",
      reason:
        result.reason === "suppressed" ? "suppressed" : "provider_refused",
    };
  } catch {
    return { email: "failed", reason: "provider_refused" };
  }
}

/**
 * Seconds until send-key may run again for this licence, or 0 now. Counts attempts that did not fail
 * (a `license.key.send.failed` row with the attempt as its parent frees it), read from the audit trail so it holds across isolates.
 */
export async function sendKeyRetryAfter(
  ctx: LicenseAdminContext,
  licenseId: string,
): Promise<number> {
  const row = await ctx.db.first<{ at: number }>(
    `SELECT a.at FROM audit a WHERE a.product = ? AND a.action = ? AND a.target_id = ?
       AND a.at > ?
       AND NOT EXISTS (SELECT 1 FROM audit f WHERE f.product = a.product AND f.parent_id = a.id AND f.action = ?)
     ORDER BY a.at DESC LIMIT 1`,
    ctx.product.slug,
    SEND_KEY_ACTION,
    licenseId,
    ctx.now - SEND_KEY_WINDOW_SECONDS,
    SEND_KEY_FAILED_ACTION,
  );
  if (!row) return 0;
  return Math.max(0, row.at + SEND_KEY_WINDOW_SECONDS - ctx.now);
}

/**
 * `POST …/licenses/<id>/send-key {revokeOthers?}`: mint a new key (labelled "Sent by email"),
 * email it to the licence's address and, with `revokeOthers`, revoke the licence's other active
 * keys in the same batch as the insert. Once per 10 minutes per licence (429 `rate_limited`
 * with `retryAfter`); refused on a floating licence (a key is never emailed to nobody, D11).
 * The new key is valid even when the email fails (the answer says so); the response is the one
 * place besides the email that carries it.
 */
export async function handleSendKey(
  ctx: LicenseAdminContext,
  license: LicenseRow,
): Promise<Response> {
  const { req, env, db, product, session, now } = ctx;
  if (req.method !== "POST")
    return err(405, ErrorCode.BadRequest, "method not allowed");
  const body = await readBody(req);
  if ("revokeOthers" in body && typeof body.revokeOthers !== "boolean")
    return err(
      422,
      ErrorCode.BadRequest,
      "revokeOthers must be true or false",
      {
        fields: ["revokeOthers"],
      },
    );
  const revokeOthers = body.revokeOthers === true;
  const context: KeyEmailContext =
    body.context === "assigned" ? "assigned" : "sent";
  if (licenseHolder(license).kind === "floating" || !license.email?.trim())
    return err(
      400,
      ErrorCode.BadRequest,
      "a floating license has no email to send a key to; assign it first",
    );
  // A key emailed to a disabled or expired licence would say "activate" and not work.
  if (license.status !== "active")
    return err(
      409,
      ErrorCode.BadRequest,
      "enable the license before sending a key",
      { reason: "license_not_active" },
    );
  if (license.expires_at !== null && license.expires_at <= now)
    return err(
      409,
      ErrorCode.BadRequest,
      "extend the license before sending a key",
      { reason: "license_expired", expiresAt: license.expires_at },
    );
  const retryAfter = await sendKeyRetryAfter(ctx, license.id);
  if (retryAfter > 0) {
    const res = err(
      429,
      "rate_limited",
      "a key was sent for this license in the last 10 minutes",
      { retryAfter },
    );
    res.headers.set("retry-after", String(retryAfter));
    return res;
  }
  // What no retry can fix is refused before a key exists, so failures never pile up valid keys.
  const blocked = await keyEmailBlocked(ctx, license.email.trim());
  if (blocked)
    return err(409, ErrorCode.BadRequest, "the key email cannot be sent", {
      reason: blocked,
    });
  const key = mintLicenseKey(product.slug);
  const hash = await hashKey(key, env.KEY_HASH_PEPPER);
  const row = {
    product: product.slug,
    key_hash: hash,
    license_id: license.id,
    status: "active",
    label: SENT_KEY_LABEL,
    created_at: now,
    created_by: session.sub,
    last_used_at: null,
  };
  let revoked = 0;
  if (revokeOthers) revoked = await replaceLicenseKeys(db, row);
  else await insertKey(db, row);
  // The attempt is recorded BEFORE the send, so the limit holds even if the send never returns.
  // The label and the revoked count; never the key, its hash or the address.
  const attemptId = randomId("aud");
  const actor = actorColumns(actorOf(session));
  await appendAudit(db, {
    product: product.slug,
    id: attemptId,
    at: now,
    ...actor,
    action: SEND_KEY_ACTION,
    target_kind: "license",
    target_id: license.id,
    summary:
      `Sent key "${SENT_KEY_LABEL}" for ${license.id}` +
      (revokeOthers
        ? `, revoked ${revoked} other key${revoked === 1 ? "" : "s"}`
        : ""),
    after_json: JSON.stringify({ label: SENT_KEY_LABEL, revoked }),
  });
  const result = await emailLicenseKey(ctx, license, key, context);
  if (result.email === "failed")
    await appendAudit(db, {
      product: product.slug,
      at: now,
      ...actor,
      action: SEND_KEY_FAILED_ACTION,
      target_kind: "license",
      target_id: license.id,
      parent_id: attemptId,
      summary: `Key email for ${license.id} did not go out (${result.reason ?? "failed"})`,
    });
  return adminJson(
    {
      key,
      hash,
      delivered: {
        email: result.email,
        ...(result.reason ? { reason: result.reason } : {}),
      },
      revoked,
    },
    201,
  );
}
