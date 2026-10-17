/**
 * LX-27 (S-24 §8.4, D11/D12): emailing a licence key to the licence's holder. Used by the create
 * route (`delivery.email`) and by `POST …/licenses/<id>/send-key`.
 *
 * The key leaves only in the email body (sent as "<App> via Polaris Key", I-18's passthrough
 * sender, through Core's one send choke point) and in the response of the request that minted it.
 * It is never in a log, an audit summary or the subject. A send that does not go out never rolls
 * anything back: the answer says `failed` and the operator tries again through send-key.
 */

import { audit } from "../../../core/audit.js";
import { ErrorCode } from "../../../core/errors.js";
import { hashKey, mintLicenseKey } from "../../../platform/crypto.js";
import {
  replaceLicenseKeys,
  insertKey,
} from "../../../core/licensing/store.js";
import { adminJson, err, readBody } from "../../../core/console/respond.js";
import { licenseHolder } from "../../../core/licensing/licenseHolders.js";
import { deliverEmail } from "../../../core/notify/emailDelivery.js";
import { appLink, licenseKeyEmail } from "../../../core/notify/templates.js";
import {
  portalEnabled,
  portalOriginOf,
} from "../../../core/licensing/manageUrl.js";
import type { LicenseRow } from "../../../core/repo.js";
import type { LicenseAdminContext } from "./index.js";

/** What the answer reports for the email: `queued` is reserved for a deferred transport. */
export type EmailDelivered = "sent" | "queued" | "failed";

/** Label of a key minted by send-key. */
export const SENT_KEY_LABEL = "Sent by email";
/** One send-key per licence in this many seconds. */
export const SEND_KEY_WINDOW_SECONDS = 600;
/** The audit action of a send-key, and of nothing else. */
export const SEND_KEY_ACTION = "license.key.send";

/**
 * Email `key` to the licence's address. `failed` when the licence has no email, mail is not
 * configured, the recipient is suppressed, or the provider refuses; never throws.
 */
export async function emailLicenseKey(
  ctx: LicenseAdminContext,
  license: Pick<LicenseRow, "email" | "name">,
  key: string,
): Promise<EmailDelivered> {
  const to = license.email?.trim();
  if (!to || !ctx.env.EMAIL) return "failed";
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
    return result.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Seconds until send-key may run again for this licence, or 0 now. Counts only sends that went
 * out (a failed one must stay retryable), read from the audit trail so it holds across isolates.
 */
export async function sendKeyRetryAfter(
  ctx: LicenseAdminContext,
  licenseId: string,
): Promise<number> {
  const row = await ctx.db.first<{ at: number }>(
    `SELECT at FROM audit WHERE product = ? AND action = ? AND target_id = ? AND summary LIKE '%: sent%'
     ORDER BY at DESC LIMIT 1`,
    ctx.product.slug,
    SEND_KEY_ACTION,
    licenseId,
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
  if (licenseHolder(license).kind === "floating" || !license.email?.trim())
    return err(
      400,
      ErrorCode.BadRequest,
      "a floating license has no email to send a key to; assign it first",
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
  const delivered = await emailLicenseKey(ctx, license, key);
  await audit(
    db,
    product.slug,
    session,
    now,
    SEND_KEY_ACTION,
    { kind: "license", id: license.id },
    // The label and the outcome; never the key, its hash or the address.
    `Sent key "${SENT_KEY_LABEL}" for ${license.id}: ${delivered}` +
      (revokeOthers
        ? `, revoked ${revoked} other key${revoked === 1 ? "" : "s"}`
        : ""),
  );
  return adminJson(
    { key, hash, delivered: { email: delivered }, revoked },
    201,
  );
}
