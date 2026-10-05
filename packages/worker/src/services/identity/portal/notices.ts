/**
 * The portal's notice emails, as templates (docs/design/PORTAL.md §6.3, gaps G15c, G18, G23).
 *
 * Every template is a pure function of its inputs and returns the finished message — subject,
 * plain-text part and branded HTML part (`renderEmail`) — so the copy is snapshot-tested in one
 * place and the handlers only choose a template and its recipients. The rules they hold:
 *
 *   - From "Polaris Key", and named "Polaris Key" in the copy: never "Polaris Key Portal" or
 *     "the portal" (§6.1 rule 2). The sender itself is Core's `platformSender`, applied by
 *     `deliverEmail` (I-18), which `email.ts` sends every notice through.
 *   - Product NAMES and device LABELS, never slugs or device ids (§6.1 rule 10).
 *   - One call to action, deep-linking to the exact section of the signed-in app (§3.3, §3.4):
 *     `#/p/<product>`, `#/p/<product>/devices`, `#/p/<product>/download?platform=`,
 *     `#/account/methods`, `#/account/sessions`. A link only ever opens the app: it carries no
 *     token, so a forwarded email signs nobody in.
 *   - Security notices (a sign-in method added or removed, a new device, a device removed) carry
 *     "Wasn't you? Secure your account" and go to EVERY verified email on the account
 *     (`sendSecurityNotice`), so taking over one inbox is not enough to hide the change.
 *
 * Display values come from places the account holder does not fully control (a device label is
 * whatever the app sent; a product name is the operator's), so `displayValue` strips control and
 * bidirectional-override characters and bounds the length before a value reaches a subject line.
 * HTML escaping is `renderEmail`'s job and still applies on top.
 */

import { platformLabel } from "@polaris-key/manifest";
import { renderEmail, emailAssetOrigin, type EmailContent } from "./email.js";

/** A finished message: what `EMAIL.send` needs besides the addresses. */
export interface NoticeMessage {
  subject: string;
  text: string;
  html: string;
}

/** The longest display value (product name, device label, method name) a notice prints. */
export const NOTICE_VALUE_MAX = 64;

/**
 * A display value made safe for a subject line and a sentence: C0/C1 controls, line and
 * paragraph separators and bidirectional overrides become spaces, runs of whitespace collapse,
 * and anything longer than `NOTICE_VALUE_MAX` is cut with an ellipsis. Empty → `fallback`.
 */
export function displayValue(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return fallback;
  const chars = Array.from(cleaned);
  return chars.length > NOTICE_VALUE_MAX
    ? `${chars
        .slice(0, NOTICE_VALUE_MAX - 1)
        .join("")
        .trimEnd()}…`
    : cleaned;
}

/**
 * A deep link into the signed-in app: `<origin>/#/<route>`. `route` is built here from fixed
 * segments and encoded slugs only, never from caller text.
 */
export function appLink(origin: string, route: string): string {
  return `${origin}/#/${route}`;
}

function productRoute(slug: string, section?: string): string {
  const base = `p/${encodeURIComponent(slug)}`;
  return section ? `${base}/${section}` : base;
}

const NOTICE_FOOTER =
  "You are receiving this because of a change to your Polaris Key account.";
const SECURITY_FOOTER =
  "You are receiving this because of a change to your Polaris Key account. " +
  "We sent it to every verified email on the account.";
const SECURE_LABEL = "Secure your account";

interface NoticeSpec {
  subject: string;
  heading?: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  /** A security notice: adds "Wasn't you? Secure your account" and the security footer. */
  secureUrl?: string;
  footer?: string;
  /** The portal origin the links point at; also where the icon loads from. */
  origin: string;
}

function buildNotice(spec: NoticeSpec): NoticeMessage {
  const footer =
    spec.footer ?? (spec.secureUrl ? SECURITY_FOOTER : NOTICE_FOOTER);
  const lines: string[] = [...spec.paragraphs];
  if (spec.action) lines.push(`${spec.action.label}: ${spec.action.url}`);
  if (spec.secureUrl)
    lines.push(`Wasn't you? ${SECURE_LABEL}: ${spec.secureUrl}`);
  lines.push(footer);
  const content: EmailContent = {
    subject: spec.subject,
    heading: spec.heading ?? spec.subject,
    paragraphs: spec.paragraphs,
    ...(spec.action ? { action: spec.action } : {}),
    ...(spec.secureUrl
      ? { secure: { label: SECURE_LABEL, url: spec.secureUrl } }
      : {}),
    footer,
    origin: emailAssetOrigin(spec.origin),
  };
  return {
    subject: spec.subject,
    text: lines.join("\n\n"),
    html: renderEmail(content),
  };
}

// ── Library ──────────────────────────────────────────────────────────────────────────────────

/** A license was added with a key: "Mossgarden is in your library". */
export function licenseAddedNotice(input: {
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "Your new product");
  return buildNotice({
    subject: `${name} is in your library`,
    paragraphs: [
      `${name} was added to your Polaris Key account with a license key.`,
    ],
    action: {
      label: `Open ${name}`,
      url: appLink(input.origin, productRoute(input.productSlug)),
    },
    origin: input.origin,
  });
}

/**
 * S-16: a license was added to an account with its key, and the license's own email is a
 * different address. Tells the buyer which product, never which account (no address, no id).
 */
export function licenseAttachedNotice(input: {
  productName: string | null | undefined;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "Your");
  return buildNotice({
    subject: `Your ${name} license was added to a Polaris Key account`,
    paragraphs: [
      `Your ${name} license was added to a Polaris Key account with its license key.`,
      "If that wasn't you, contact the developer.",
    ],
    origin: input.origin,
  });
}

/** PX-W5 (G7): a new key replaced the license's old ones. Sent to the account and the license email. */
export function licenseKeyReplacedNotice(input: {
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "your product");
  return buildNotice({
    subject: "Your license has a new key",
    paragraphs: [
      `A new license key for ${name} was made in your Polaris Key account.`,
      "The old key no longer activates new devices; devices already using the product keep working.",
      "If this wasn't you, sign in and get a new key again, then contact the developer.",
    ],
    action: {
      label: `Open ${name}`,
      url: appLink(input.origin, productRoute(input.productSlug)),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** G23: the download link the account holder asked to have emailed. */
export function downloadLinkEmail(input: {
  productName: string | null | undefined;
  productSlug: string;
  platform: string;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "your product");
  const platform = platformLabel(input.platform, { audience: "consumer" });
  const url = appLink(
    input.origin,
    `${productRoute(input.productSlug, "download")}?platform=${encodeURIComponent(input.platform)}`,
  );
  return buildNotice({
    subject: `Download ${name} for ${platform}`,
    paragraphs: [
      `Here is the ${platform} download you asked for. Open this email on the device you want to install ${name} on.`,
      "The link opens your Polaris Key library, so you may be asked to sign in first.",
    ],
    action: { label: `Download ${name}`, url },
    footer:
      "You are receiving this because you asked Polaris Key to email you a download link. " +
      "If you didn't, you can ignore it: the link only opens your own library.",
    origin: input.origin,
  });
}

// ── Security notices ─────────────────────────────────────────────────────────────────────────

/** A device was removed from a product license: "Studio PC was removed from Tidewater Studio". */
export function deviceRemovedNotice(input: {
  deviceLabel: string | null | undefined;
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "A device");
  const name = displayValue(input.productName, "your product");
  return buildNotice({
    subject: `${device} was removed from ${name}`,
    paragraphs: [
      `${device} was removed from your ${name} license and no longer counts toward its device limit.`,
      `To use ${name} on it again, sign in to ${name} on that device.`,
    ],
    action: {
      label: "See your devices",
      url: appLink(input.origin, productRoute(input.productSlug, "devices")),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A new device signed in to the account. */
export function newDeviceSignInNotice(input: {
  deviceLabel: string | null | undefined;
  /** An approximate place, when the sign-in had one ("Lisbon, Portugal"). */
  location?: string | null;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "A new device");
  const location = input.location ? displayValue(input.location, "") : "";
  return buildNotice({
    subject: "A new device signed in to Polaris Key",
    paragraphs: [
      location
        ? `${device} signed in to your Polaris Key account, near ${location}.`
        : `${device} signed in to your Polaris Key account.`,
      "If this was you, there is nothing to do.",
    ],
    action: {
      label: "Review your sign-ins",
      url: appLink(input.origin, "account/sessions"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A sign-in method was connected: "Steam was connected to your Polaris Key account". */
export function signInMethodAddedNotice(input: {
  /** The method by its own name: "Apple", "Google", "Steam", "A passkey", an email address. */
  method: string;
  origin: string;
}): NoticeMessage {
  const method = displayValue(input.method, "A sign-in method");
  return buildNotice({
    subject: `${method} was connected to your Polaris Key account`,
    paragraphs: [
      `${method} was added as a way to sign in to your Polaris Key account.`,
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A sign-in method was removed: "Steam was disconnected from your Polaris Key account". */
export function signInMethodRemovedNotice(input: {
  method: string;
  origin: string;
}): NoticeMessage {
  const method = displayValue(input.method, "A sign-in method");
  return buildNotice({
    subject: `${method} was disconnected from your Polaris Key account`,
    paragraphs: [
      `${method} can no longer be used to sign in to your Polaris Key account.`,
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The account was deleted at the holder's request (sent before the rows go). */
export function accountDeletedNotice(input: { origin: string }): NoticeMessage {
  return buildNotice({
    subject: "Your Polaris Key account has been deleted",
    paragraphs: [
      "Your Polaris Key account, its email addresses and its sign-in methods have been erased, as you asked.",
      "Deleting it doesn't cancel your licenses: they stay with each developer, and you can add them again with a new account. To have a developer erase its own records, contact that developer's support.",
    ],
    footer:
      "You are receiving this because your Polaris Key account was deleted. " +
      "We sent it to every verified email on the account.",
    origin: input.origin,
  });
}

// ── Accounts (I-05) ──────────────────────────────────────────────────────────────────────────

/** Two accounts were joined into one, after the person signed in to both (S-16 §5.1, D21). */
export function accountsMergedNotice(input: { origin: string }): NoticeMessage {
  return buildNotice({
    subject: "Two Polaris Key accounts were joined",
    paragraphs: [
      "Two Polaris Key accounts were joined into one after someone signed in to both. Their sign-in methods and licenses are now on a single account.",
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/**
 * I-04 §8 Q1: a license had links to several accounts and keeps one owner; this account was not
 * it. Says which product, never which account owns it now.
 */
export function licenseLinkSupersededNotice(input: {
  productName: string | null | undefined;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "A");
  return buildNotice({
    subject: `A ${name} license left your library`,
    paragraphs: [
      `A ${name} license was linked to more than one Polaris Key account. A license now belongs to one account, and another account holds this one, so it has left your library.`,
      "If you bought it, contact the developer: they can move it to your account.",
    ],
    origin: input.origin,
  });
}

// ── The developer's relink tool (I-12) ──────────────────────────────────────────────────────

/** How long the developer can undo a relink, as the notices say it. */
const RELINK_UNDO_WORDS = "72 hours";

/**
 * S-16 §5.4 item 9: the developer is moving a licence OUT of this account. Sent to every verified
 * email on the account before the move takes effect. Says which product, never which account
 * receives it.
 */
export function licenseRelinkedAwayNotice(input: {
  productName: string | null | undefined;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "A");
  return buildNotice({
    subject: `The developer moved your ${name} license to another account`,
    paragraphs: [
      `The developer of ${name} moved one of its licenses from your Polaris Key account to another account, at the request of its support.`,
      `If you did not expect this, contact the developer's support now: they can undo it for ${RELINK_UNDO_WORDS}.`,
    ],
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The receiving side of a relink: a licence is being added to this account by the developer. */
export function licenseRelinkedInNotice(input: {
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "A product");
  return buildNotice({
    subject: `${name} is being added to your library`,
    paragraphs: [
      `The developer of ${name} moved one of its licenses to your Polaris Key account, at the request of its support.`,
      `If you did not ask for this, contact the developer's support: they can undo it for ${RELINK_UNDO_WORDS}.`,
    ],
    action: {
      label: `Open ${name}`,
      url: appLink(input.origin, productRoute(input.productSlug)),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A relink was undone: the licence goes back to the account it came from. */
export function licenseRelinkUndoneNotice(input: {
  productName: string | null | undefined;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "A");
  return buildNotice({
    subject: `The developer undid a move of a ${name} license`,
    paragraphs: [
      `The developer of ${name} undid an earlier move of one of its licenses. The license goes back to the account it came from.`,
      "If you did not expect this, contact the developer's support.",
    ],
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}
