/**
 * Sending platform mail: the magic sign-in link, the login card's code email and the account
 * notices (whose copy lives in `templates.ts`).
 *
 * Every message is customer mail, sent as "Polaris Locker" (LK-07) through Core's one send choke point
 * (`emailDelivery.ts`, I-18), which applies the suppression list, the Apple private-relay
 * gate and the provider-error handling; platform mail is never counted against a product cap.
 * Every message carries a plain-text part (the canonical copy) and a branded HTML part.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { portalAudit } from "../accounts/portalAudit.js";
import { deliverEmail } from "./emailDelivery.js";
import { linkText, whatIsLockerLink } from "../helpLinks.js";
import { emailAssetOrigin, renderEmail } from "./render.js";
import { securityNoticeRecipients } from "./recipients.js";
import type { NoticeMessage } from "./templates.js";

/**
 * Mail a magic sign-in link. False only when email cannot be sent at all (`email_unavailable`);
 * a suppressed recipient answers true, exactly like a sent message, so the response does not
 * reveal that the address once bounced or complained.
 */
export async function sendMagicLink(
  env: Env,
  db: Db,
  to: string,
  link: string,
  now: number,
): Promise<boolean> {
  const subject = "Sign in to Polaris Locker";
  const assetOrigin = emailAssetOrigin(link, env.CONSOLE_ORIGIN);
  const result = await deliverEmail(
    env,
    db,
    {
      sender: { kind: "platform" },
      to,
      subject,
      text:
        `Sign in to Polaris Locker\n\nUse this link to sign in:\n\n${link}\n\n` +
        `This link expires in 10 minutes and works once. If you did not ask to sign in, you can ignore this email.` +
        helpText(assetOrigin),
      html: renderEmail({
        subject,
        heading: "Sign in to Polaris Locker",
        paragraphs: [
          "Use the button below to sign in. The link expires in 10 minutes and works once.",
        ],
        action: { label: "Sign in", url: link },
        footer:
          "If you did not ask to sign in, you can ignore this email. Nothing changes until the link is used.",
        ...helpLinks(assetOrigin),
        origin: assetOrigin,
        brand: "locker",
      }),
    },
    now,
  );
  return result.ok || result.reason === "suppressed";
}

/** The sign-in mails link "What is Polaris Locker?" only (DOC-06b). */
function helpLinks(origin: string | null) {
  return origin ? { footerLinks: [whatIsLockerLink(origin)] } : {};
}
function helpText(origin: string | null): string {
  if (!origin) return "";
  return `\n\n${linkText(whatIsLockerLink(origin))}`;
}

/**
 * The login card's sign-in email (I-07): one message carrying the 6-digit code and, for a card
 * sign-in, the magic link, so the person can type the code on the device that asked or open the
 * link (which confirms that device's sign-in from wherever it is opened). The gate's
 * confirmation mail carries the code only (`link: null`).
 *
 * Answers `"sent"` for a delivered OR suppressed recipient (enumeration safety: a suppressed
 * address must look exactly like a sent one) and `"unavailable"` only when mail cannot leave at
 * all (`email_unavailable`).
 */
export async function sendSignInEmail(
  env: Env,
  db: Db,
  to: string,
  content: {
    code: string;
    link: string | null;
    purpose: "signin" | "confirm";
  },
  now: number,
): Promise<"sent" | "unavailable"> {
  const spaced = `${content.code.slice(0, 3)} ${content.code.slice(3)}`;
  const confirm = content.purpose === "confirm";
  // SIGN-IN.md §3.4 / §3.15: the code in the subject, then first and large in the body.
  const subject = confirm
    ? "Confirm your email for Polaris Locker"
    : `Your Polaris Locker code: ${content.code}`; // signin.email.subject
  const heading = confirm ? "Confirm your email" : "Your Polaris Locker code";
  const lines = content.link
    ? [
        // signin.email.body
        "Or sign in with the button. The code and the link work once, for 10 minutes.",
      ]
    : ["The code works once, for 10 minutes."];
  const textLines = content.link
    ? [
        "Or sign in with this link. The code and the link work once, for 10 minutes.",
      ]
    : lines;
  const footer = confirm
    ? "If you did not ask for this, you can ignore this email. Nothing changes until it is used."
    : "If you did not ask to sign in, you can ignore this email. Nothing changes until the link is used.";
  const assetOrigin = emailAssetOrigin(content.link, env.CONSOLE_ORIGIN);
  const result = await deliverEmail(
    env,
    db,
    {
      sender: { kind: "platform" },
      to,
      subject,
      text:
        `${heading}: ${spaced}\n\n` +
        textLines.join("\n\n") +
        (content.link ? `\n\n${content.link}` : "") +
        `\n\n${footer}` +
        helpText(assetOrigin),
      html: renderEmail({
        subject,
        heading,
        code: spaced,
        paragraphs: lines,
        ...(content.link
          ? { action: { label: "Sign in", url: content.link } }
          : {}),
        footer,
        ...helpLinks(assetOrigin),
        origin: assetOrigin,
        brand: "locker",
      }),
    },
    now,
  );
  return result.ok || result.reason === "suppressed" ? "sent" : "unavailable";
}

/**
 * One notice to one address, through Core's send choke point (`deliverEmail`). No binding or no
 * address: nothing is sent. True only when it went out; an unavailable or suppressed recipient
 * answers false, and nothing here throws on a provider error.
 */
export async function sendNotice(
  env: Env,
  db: Db,
  to: string | null | undefined,
  message: NoticeMessage,
  now: number,
): Promise<boolean> {
  if (!to || !env.EMAIL) return false;
  const result = await deliverEmail(
    env,
    db,
    { sender: { kind: "platform" }, to, ...message },
    now,
  );
  return result.ok;
}

/**
 * A security notice (PORTAL.md §6.3): one message per address, to every verified email on the
 * account plus `alsoTo` (the session's address, which a brand-new account may not have verified
 * a row for yet). Sent separately, so no recipient sees the others in the headers. An email
 * sign-in method is named generically in its notices ("An email address", `methodLabel`, PX-W12),
 * so no notice hands one of the account's addresses to the others.
 *
 * A recipient that is not sent to (unavailable, suppressed, or a failed send) never fails the
 * change the notice reports (a device is already removed, an account is about to be erased); the
 * others still go out. Returns how many were sent.
 */
export async function sendSecurityNotice(
  env: Env,
  db: Db,
  accountId: string,
  alsoTo: string | null | undefined,
  message: NoticeMessage,
  now: number,
): Promise<number> {
  if (!env.EMAIL) {
    await recordUndelivered(db, accountId, 0, 0, now);
    return 0;
  }
  const recipients = await securityNoticeRecipients(db, accountId, alsoTo);
  let sent = 0;
  for (const to of recipients) {
    try {
      if (await sendNotice(env, db, to, message, now)) sent += 1;
    } catch {
      // Swallowed on purpose: the change already happened (or is about to); the worker has no
      // console logging (test/attack/R12-secrets.test.ts), so the shortfall is the return value.
    }
  }
  // An account with no deliverable address (email-less, suppressed, mail down) gets no
  // out-of-band notice; leave a row so the change is not silent. Counts only, never an address.
  if (sent === 0)
    await recordUndelivered(db, accountId, recipients.length, 0, now);
  return sent;
}

async function recordUndelivered(
  db: Db,
  accountId: string,
  recipients: number,
  sent: number,
  now: number,
): Promise<void> {
  try {
    await portalAudit(db, {
      accountId,
      action: "security.notice.undelivered",
      summary: `Security notice reached ${sent} of ${recipients} recipients`,
      now,
    });
  } catch {
    // Never fails the change the notice reports.
  }
}
