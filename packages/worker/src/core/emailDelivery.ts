/// <reference types="@cloudflare/workers-types" />
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import { rateLimitOk } from "./rateLimit.js";
import {
  EMAIL_SEND_PRODUCT_DAILY_DEFAULT,
  recipientHash,
} from "./emailLimits.js";
import { passthroughSender, platformSender } from "./emailSender.js";

// The ONE place sign-in and account email leaves the Worker (I-18). Every send, platform or
// passthrough, goes through `deliverEmail`, which applies, in order:
//
//   1. a configured binding, else `email_unavailable`;
//   2. the sender: "Polaris Key" for platform mail, "<App> via Polaris Key" for passthrough
//      (`emailSender.ts`); a product whose display name and slug are both refused gets
//      `email_unavailable` rather than the platform's name;
//   3. Apple private relay: `@privaterelay.appleid.com` accepts mail only from sender domains
//      registered in the Apple developer account, so until the owner records that registration
//      (`EMAIL_APPLE_RELAY = "registered"`) a relay recipient gets `email_unavailable` instead
//      of a send that would bounce against the shared sender's reputation;
//   4. the hashed suppression list (`email_suppressions`): a suppressed recipient is NEVER sent
//      to; it answers `suppressed`, which callers answer exactly as they answer a sent message
//      (enumeration safety, S-16 §5.4 item 4). A store that cannot be read refuses (fail closed);
//   5. passthrough only: the per-product daily cap (`productDailyEmailCap`), charged here, after
//      suppression, so it counts only mail that really leaves. A capped product answers
//      `email_unavailable`. Platform mail (account notices, the dormant-account warning, merge and
//      join notices) is never capped (owner, 2026-10-04);
//   6. the send itself. A provider refusal never escapes as an exception: `E_RECIPIENT_SUPPRESSED`
//      (Cloudflare suppressed the address after a hard bounce or a complaint) is recorded in our
//      list and answers `suppressed`; every other failure (quota, rate, unverified sender, an
//      outage) answers `email_unavailable`.
//
// Bounce and complaint EVENTS: Cloudflare Email Service exposes no push notification for them to
// a Worker (checked 2026-10-04 against developers.cloudflare.com/email-service). What exists:
// the binding's `E_RECIPIENT_SUPPRESSED` on a later send (handled in step 6), the account and
// zone suppression lists over the REST API, and the GraphQL `emailSendingAdaptive` events. All
// three feed `recordDeliveryEvent`, the hook a future poller or operator tool calls; step 6 is the
// only caller today.
//
// `email_unavailable` is a reason in a return value, not a wire code: the route that answers it
// (the login card, I-07) maps it to its response, and the error-code registry entry belongs to
// that route's contract (I-04).

/** Recipients at this domain are Apple private-relay addresses. */
export const APPLE_PRIVATE_RELAY_DOMAIN = "privaterelay.appleid.com";

/** How long a hard bounce suppresses an address before one more attempt is allowed. */
export const HARD_BOUNCE_SUPPRESSION_SECONDS = 90 * 86_400;

/** Why an address is on the suppression list. */
export type SuppressionReason =
  /** A permanent delivery failure. Expires after `HARD_BOUNCE_SUPPRESSION_SECONDS`. */
  | "hard_bounce"
  /** The recipient reported the mail as spam. Permanent. */
  | "complaint"
  /** The provider refused the address as already suppressed. Permanent until cleared. */
  | "provider"
  /** An operator added it. Permanent until cleared. */
  | "operator";

export type EmailSender =
  | { kind: "platform" }
  | {
      kind: "passthrough";
      product: string;
      /** The product's display name (`products.name`); refused names fall back to the slug. */
      displayName: string | null;
    };

export interface OutgoingEmail {
  to: string;
  subject: string;
  /** The canonical plain-text part. */
  text: string;
  html?: string;
  sender: EmailSender;
}

export type DeliveryResult =
  | { ok: true }
  | { ok: false; reason: "email_unavailable" | "suppressed" };

const DAY = 86_400;

/** Whether an address is an Apple private-relay address. */
export function isApplePrivateRelay(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${APPLE_PRIVATE_RELAY_DOMAIN}`);
}

/** Whether the owner has registered the sender with Apple's private relay (RUNBOOK). */
export function applePrivateRelayRegistered(env: Env): boolean {
  return env.EMAIL_APPLE_RELAY === "registered";
}

function positiveInt(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * A product's daily passthrough-mail cap: its `email_product_caps` row, else the deploy's
 * `EMAIL_PRODUCT_DAILY_CAP` var, else `EMAIL_SEND_PRODUCT_DAILY_DEFAULT`. An unreadable row reads
 * as absent (the deploy-wide value still caps the product).
 */
export async function productDailyEmailCap(
  env: Env,
  db: Db,
  product: string,
): Promise<number> {
  let row: { daily_cap: number } | null = null;
  try {
    row = await db.first<{ daily_cap: number }>(
      "SELECT daily_cap FROM email_product_caps WHERE product = ?",
      product,
    );
  } catch {
    row = null;
  }
  return (
    positiveInt(row?.daily_cap) ??
    positiveInt(env.EMAIL_PRODUCT_DAILY_CAP) ??
    EMAIL_SEND_PRODUCT_DAILY_DEFAULT
  );
}

/** Set (or, with `null`, clear) a product's own daily cap. */
export async function setProductDailyEmailCap(
  db: Db,
  product: string,
  dailyCap: number | null,
  now: number,
): Promise<void> {
  if (dailyCap === null) {
    await db.run("DELETE FROM email_product_caps WHERE product = ?", product);
    return;
  }
  if (positiveInt(dailyCap) === null)
    throw new Error("a daily cap is a positive integer");
  await db.run(
    `INSERT INTO email_product_caps (product, daily_cap, modified_at) VALUES (?, ?, ?)
     ON CONFLICT(product) DO UPDATE SET daily_cap = excluded.daily_cap,
                                        modified_at = excluded.modified_at`,
    product,
    dailyCap,
    now,
  );
}

/**
 * Whether a recipient is suppressed now. Throws when the store cannot be read, so the caller
 * fails closed.
 */
export async function emailSuppressed(
  env: Env,
  db: Db,
  email: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{ expires_at: number | null }>(
    "SELECT expires_at FROM email_suppressions WHERE address_hash = ?",
    await recipientHash(env, email),
  );
  return row !== null && (row.expires_at === null || row.expires_at > now);
}

/**
 * Put a recipient on the suppression list (keyed by the peppered hash; the address is never
 * stored). A permanent reason replaces an expiring one; an expiring one never shortens a
 * permanent entry.
 */
export async function suppressEmail(
  env: Env,
  db: Db,
  email: string,
  reason: SuppressionReason,
  now: number,
): Promise<void> {
  const expires =
    reason === "hard_bounce" ? now + HARD_BOUNCE_SUPPRESSION_SECONDS : null;
  await db.run(
    `INSERT INTO email_suppressions (address_hash, reason, created_at, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(address_hash) DO UPDATE SET
       reason = CASE WHEN email_suppressions.expires_at IS NULL
                      AND excluded.expires_at IS NOT NULL
                     THEN email_suppressions.reason ELSE excluded.reason END,
       created_at = excluded.created_at,
       expires_at = CASE WHEN email_suppressions.expires_at IS NULL
                          OR excluded.expires_at IS NULL
                         THEN NULL ELSE excluded.expires_at END`,
    await recipientHash(env, email),
    reason,
    now,
    expires,
  );
}

/** Take a recipient off the suppression list (an operator action after the cause is fixed). */
export async function unsuppressEmail(
  env: Env,
  db: Db,
  email: string,
): Promise<void> {
  await db.run(
    "DELETE FROM email_suppressions WHERE address_hash = ?",
    await recipientHash(env, email),
  );
}

/** A delivery outcome reported by the provider, from whatever channel exposes it. */
export interface DeliveryEvent {
  type: "hard_bounce" | "soft_bounce" | "complaint" | "provider_suppressed";
  recipient: string;
}

/**
 * The bounce and complaint hook: a hard bounce suppresses for
 * `HARD_BOUNCE_SUPPRESSION_SECONDS`, a complaint or a provider suppression permanently; a soft
 * bounce changes nothing (the provider retries those itself).
 */
export async function recordDeliveryEvent(
  env: Env,
  db: Db,
  event: DeliveryEvent,
  now: number,
): Promise<void> {
  if (event.type === "soft_bounce") return;
  const reason: SuppressionReason =
    event.type === "provider_suppressed" ? "provider" : event.type;
  await suppressEmail(env, db, event.recipient, reason, now);
}

/** The `E_*` code a binding refusal carries, if any. */
function providerCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

/** Send one message through every I-18 control; see the header comment for the order. */
export async function deliverEmail(
  env: Env,
  db: Db,
  msg: OutgoingEmail,
  now: number,
): Promise<DeliveryResult> {
  const unavailable: DeliveryResult = {
    ok: false,
    reason: "email_unavailable",
  };
  const binding = env.EMAIL;
  if (!binding) return unavailable;

  const from =
    msg.sender.kind === "platform"
      ? platformSender(env)
      : passthroughSender(env, msg.sender.displayName, msg.sender.product);
  if (!from) return unavailable;

  if (isApplePrivateRelay(msg.to) && !applePrivateRelayRegistered(env))
    return unavailable;

  try {
    if (await emailSuppressed(env, db, msg.to, now))
      return { ok: false, reason: "suppressed" };
  } catch {
    return unavailable;
  }

  if (msg.sender.kind === "passthrough") {
    const product = msg.sender.product;
    const allowed = await rateLimitOk(
      env,
      product,
      {
        bucket: "emailSendProductDay",
        id: product,
        limit: await productDailyEmailCap(env, db, product),
        windowSec: DAY,
      },
      now,
    );
    if (!allowed) return unavailable;
  }

  try {
    await binding.send({
      from,
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      ...(msg.html !== undefined ? { html: msg.html } : {}),
    });
    return { ok: true };
  } catch (err) {
    const code = providerCode(err);
    if (code === "E_RECIPIENT_SUPPRESSED") {
      try {
        await recordDeliveryEvent(
          env,
          db,
          { type: "provider_suppressed", recipient: msg.to },
          now,
        );
      } catch {
        // The provider keeps refusing the address either way.
      }
      return { ok: false, reason: "suppressed" };
    }
    // Quota, rate, an unverified sender or an outage: the caller offers another sign-in method.
    return unavailable;
  }
}
