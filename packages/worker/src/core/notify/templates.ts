/**
 * The portal's notice emails, as templates (docs/design/PORTAL.md §6.3, gaps G15c, G18, G23).
 *
 * Every template is a pure function of its inputs and returns the finished message — subject,
 * plain-text part and branded HTML part (`renderEmail`) — so the copy is snapshot-tested in one
 * place and the handlers only choose a template and its recipients. The rules they hold:
 *
 *   - From "Polaris Locker", and named "Polaris Locker" in the copy (LK-07: the customer site and
 *     its mail are Polaris Locker; operator mail is Polaris Key): never "Polaris Locker Portal" or
 *     "the portal" (§6.1 rule 2). The sender itself is Core's `platformSender`, applied by
 *     `deliverEmail` (I-18), which `send.ts` sends every notice through.
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

import {
  INVITE_FOOTERS,
  inviteEmailIntro,
  inviteEmailPrimaryLabel,
  inviteEmailSubject,
  type InviteEmailContext,
  KEY_EMAIL_AFTER,
  KEY_FOOTERS,
  keyEmailIntro,
  keyEmailPrimaryLabel,
  keyEmailSubject,
  type KeyEmailContext,
} from "@polaris-key/brand/email-copy";
import { platformLabel } from "@polaris-key/manifest";
import { PERSONAL_TOKEN_DAYS } from "../accounts/personalTokens.js";
import {
  aboutThisEmailLink,
  linkText,
  secureHelpLink,
  whatIsLockerLink,
} from "../helpLinks.js";
import { renderEmail, emailAssetOrigin, type EmailContent } from "./render.js";

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
  "You are receiving this because of a change to your Polaris Locker account.";
const SECURITY_FOOTER =
  "You are receiving this because of a change to your Polaris Locker account. " +
  "We sent it to every verified email on the account.";
const SECURE_LABEL = "Secure your account";

interface NoticeSpec {
  subject: string;
  heading?: string;
  paragraphs: string[];
  /** The one fact the reader must not miss, as a neutral callout after the paragraphs. */
  callout?: string;
  action?: { label: string; url: string };
  /** A security notice: adds "Wasn't you? Secure your account" and the security footer. */
  secureUrl?: string;
  footer?: string;
  /** The portal origin the links point at; also where the icon loads from. */
  origin: string;
  /** The identity of the mail: Polaris Locker by default; `key` for an operator notice. */
  brand?: "key" | "locker";
  /** This notice's entry on the Help "Emails" page: a fixed anchor id (`help/emails.md`). */
  help?: string;
}

/** Locker mail's Help footer links as `EmailContent` fields (empty without a usable origin). */
function lockerHelp(
  origin: string,
  anchor: string,
  secure = false,
): Pick<EmailContent, "footerLinks"> {
  const base = emailAssetOrigin(origin);
  if (!base) return {};
  return {
    footerLinks: [
      ...(secure ? [secureHelpLink(base)] : []),
      whatIsLockerLink(base),
      aboutThisEmailLink(base, anchor),
    ],
  };
}

/** The plain-text part's matching `label: url` lines after the small print. */
function withHelpText(text: string, c: EmailContent): string {
  return [text, ...(c.footerLinks ?? []).map(linkText)].join("\n\n");
}

function buildNotice(spec: NoticeSpec): NoticeMessage {
  const footer =
    spec.footer ?? (spec.secureUrl ? SECURITY_FOOTER : NOTICE_FOOTER);
  const heading = spec.heading ?? spec.subject;
  // The plain-text part mirrors the HTML, top to bottom: heading, copy, callout, action, secure
  // line, small print.
  const lines: string[] = [heading, ...spec.paragraphs];
  if (spec.callout) lines.push(spec.callout);
  if (spec.action) lines.push(`${spec.action.label}: ${spec.action.url}`);
  if (spec.secureUrl)
    lines.push(`Wasn't you? ${SECURE_LABEL}: ${spec.secureUrl}`);
  lines.push(footer);
  // Locker mail links Help in the footer; an operator (Key) notice does not (DOC-06b D-W1).
  const helped =
    spec.help && (spec.brand ?? "locker") === "locker"
      ? lockerHelp(spec.origin, spec.help, Boolean(spec.secureUrl))
      : {};
  for (const l of helped.footerLinks ?? []) lines.push(linkText(l));
  const content: EmailContent = {
    subject: spec.subject,
    heading,
    paragraphs: spec.paragraphs,
    ...(spec.callout ? { callout: spec.callout } : {}),
    ...(spec.action ? { action: spec.action } : {}),
    ...(spec.secureUrl
      ? { secure: { label: SECURE_LABEL, url: spec.secureUrl } }
      : {}),
    footer,
    ...helped,
    origin: emailAssetOrigin(spec.origin),
    brand: spec.brand ?? "locker",
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
    help: "license-added",
    subject: `${name} is in your library`,
    paragraphs: [
      `${name} was added to your Polaris Locker account with a license key.`,
    ],
    action: {
      label: `Open ${name}`,
      url: appLink(input.origin, productRoute(input.productSlug)),
    },
    origin: input.origin,
  });
}

/**
 * LX-26 N1 / LX-27c.3: a license waiting on the address joined the account when the address was
 * verified. "From <developer>" names who it comes from (the listing's developer, else the product
 * name). It never says how it was delivered and never carries a key or another address.
 */
export function licenseFromDeveloperNotice(input: {
  productName: string | null | undefined;
  productSlug: string;
  developerName?: string | null;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "Your new product");
  const from = displayValue(input.developerName, name);
  return buildNotice({
    help: "license-from-developer",
    subject: `${name} is in your Polaris Locker library`,
    paragraphs: [`From ${from}.`, `${name} was added to your library.`],
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
    help: "license-attached",
    subject: `Your ${name} license was added to a Polaris Locker account`,
    paragraphs: [
      `Your ${name} license was added to a Polaris Locker account with its license key.`,
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
    help: "license-key-replaced",
    subject: "Your license has a new key",
    paragraphs: [
      `A new license key for ${name} was made in your Polaris Locker account.`,
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
    help: "download-link",
    subject: `Download ${name} for ${platform}`,
    paragraphs: [
      `Here is the ${platform} download you asked for. Open this email on the device you want to install ${name} on.`,
      "The link opens your Polaris Locker library, so you may be asked to sign in first.",
    ],
    action: { label: `Download ${name}`, url },
    footer:
      "You are receiving this because you asked Polaris Locker to email you a download link. " +
      "If you didn't, you can ignore it: the link only opens your own library.",
    origin: input.origin,
  });
}

/** Why the key email was sent: it picks the footer, which must be true for each path. */
export type { KeyEmailContext };

/**
 * LX-27 (S-24 §8.4, D11/D12): the key an operator emailed to a licence's holder, sent as
 * "<App> via Polaris Locker" (the caller picks the sender). The product is the hero (name, and its
 * icon when it has a hosted one); the key sits in a monospace box in the body only, never in the
 * subject. The primary button is the product's download when it has one, else **Open in Polaris
 * Locker**, a plain portal sign-in link that carries no token, so a forwarded email signs nobody in.
 */
export function licenseKeyEmail(input: {
  productName: string | null | undefined;
  holderName: string | null | undefined;
  key: string;
  /** The portal's sign-in page; carries no token. */
  signInUrl: string;
  /** The product's download page, when it has one. */
  downloadUrl?: string | null;
  /** The product's hosted icon (https), when it has one. */
  iconUrl?: string | null;
  context?: KeyEmailContext;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "");
  const holder = displayValue(input.holderName, "");
  const subject = keyEmailSubject(name);
  const footer = KEY_FOOTERS[input.context ?? "created"];
  const intro = keyEmailIntro(holder);
  const after = [KEY_EMAIL_AFTER];
  const primary = input.downloadUrl
    ? { label: keyEmailPrimaryLabel(true), url: input.downloadUrl }
    : { label: keyEmailPrimaryLabel(false), url: input.signInUrl };
  const secondary = input.downloadUrl
    ? { label: keyEmailPrimaryLabel(false), url: input.signInUrl }
    : undefined;
  const text = [
    ...(name ? [name] : []),
    ...intro,
    input.key,
    ...after,
    `${primary.label}: ${primary.url}`,
    ...(secondary ? [`${secondary.label}: ${secondary.url}`] : []),
    footer,
  ].join("\n\n");
  const content: EmailContent = {
    subject,
    heading: name || "Your license",
    ...(name
      ? { hero: { name, ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}) } }
      : {}),
    paragraphs: intro,
    secret: input.key,
    paragraphsAfter: after,
    action: primary,
    ...(secondary ? { secondary } : {}),
    footer,
    ...lockerHelp(input.origin, "license-key"),
    origin: emailAssetOrigin(input.origin),
    brand: "locker",
  };
  return {
    subject,
    text: withHelpText(text, content),
    html: renderEmail(content),
  };
}

/** Why the invitation was sent: it picks the footer. */
export type { InviteEmailContext };

/**
 * LX-27c: the invitation an operator emailed to a licence's holder, sent as "<App> via Polaris
 * Locker" like the key email and rendered the same way (product hero, download or **Open in Polaris
 * Locker**). It carries no key and no token, and the sign-in link names no address, so a forwarded
 * email signs nobody in and a URL in a log says nothing about who. The address is in the body
 * only. The copy does not depend on whether the address has an account (D4).
 */
export function licenseInvitationEmail(input: {
  productName: string | null | undefined;
  holderName: string | null | undefined;
  /** The licence's address, named in the body ("Sign in with ada@example.com"). */
  address: string;
  /** The portal's sign-in page; carries no token and no address. */
  signInUrl: string;
  /** The product's download page, when it has one. */
  downloadUrl?: string | null;
  /** The product's hosted icon (https), when it has one. */
  iconUrl?: string | null;
  context?: InviteEmailContext;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "");
  const holder = displayValue(input.holderName, "");
  const subject = inviteEmailSubject(name);
  const footer = INVITE_FOOTERS[input.context ?? "created"];
  // The address is what the reader must type: stripped of control and bidi characters, never cut.
  const intro = inviteEmailIntro(holder, name, plainAddress(input.address));
  const primary = input.downloadUrl
    ? { label: inviteEmailPrimaryLabel(true), url: input.downloadUrl }
    : { label: inviteEmailPrimaryLabel(false), url: input.signInUrl };
  const secondary = input.downloadUrl
    ? { label: inviteEmailPrimaryLabel(false), url: input.signInUrl }
    : undefined;
  const text = [
    ...(name ? [name] : []),
    ...intro,
    `${primary.label}: ${primary.url}`,
    ...(secondary ? [`${secondary.label}: ${secondary.url}`] : []),
    footer,
  ].join("\n\n");
  const content: EmailContent = {
    subject,
    heading: name || "Your license",
    ...(name
      ? { hero: { name, ...(input.iconUrl ? { iconUrl: input.iconUrl } : {}) } }
      : {}),
    paragraphs: intro,
    wrapAnywhere: true,
    action: primary,
    ...(secondary ? { secondary } : {}),
    footer,
    ...lockerHelp(input.origin, "license-invited"),
    origin: emailAssetOrigin(input.origin),
    brand: "locker",
  };
  return {
    subject,
    text: withHelpText(text, content),
    html: renderEmail(content),
  };
}

/** An email address for display: control, line-break, bidi and space characters removed, never cut. */
function plainAddress(raw: string): string {
  return raw.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\s]/g,
    "",
  );
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
    help: "device-removed",
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

/**
 * A Replace from the sign-in card freed a seat (SIGN-IN.md §3.15): `signin.mail.replaced.subject`,
 * `signin.mail.replaced.body` and **Open Polaris Locker** (`signin.mail.open`).
 */
export function deviceReplacedNotice(input: {
  deviceLabel: string | null | undefined;
  /** The device that took the seat. */
  newDeviceLabel: string | null | undefined;
  productName: string | null | undefined;
  productSlug: string;
  at: number;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "A device");
  const newDevice = displayValue(input.newDeviceLabel, "A new device");
  const name = displayValue(input.productName, "your product");
  return buildNotice({
    help: "device-replaced",
    subject: `${name} signed out on ${device}`, // signin.mail.replaced.subject
    paragraphs: [
      // signin.mail.replaced.body
      `${device} was replaced by ${newDevice} when you signed in to ${name} on ${emailDate(input.at)}. It can sign in again later if there is room for another device. If this wasn't you, open Polaris Locker and check your devices.`,
    ],
    action: {
      label: "Open Polaris Locker", // signin.mail.open
      url: appLink(input.origin, productRoute(input.productSlug, "devices")),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/**
 * A nearby approval bound a device (WIRE-CONTRACT-V5 §12.11.5 rule 7): "Diceroll signed in on
 * Living room TV". Sent to the primary address only, so it is not a security notice (no "every
 * verified email" footer); the remedy is the product's devices page. The label may be null.
 */
export function appDeviceApprovedNotice(input: {
  deviceLabel: string | null | undefined;
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "a new device");
  const name = displayValue(input.productName, "An app");
  // Without a label there is nothing to name twice: "remove it".
  const it = displayValue(input.deviceLabel, "") === "" ? "it" : device;
  return buildNotice({
    help: "app-device-approved",
    subject: `${name} signed in on ${device}`,
    paragraphs: [
      "You approved it from another device.",
      `If this wasn't you, remove ${it} from your devices in Polaris Locker.`,
    ],
    action: {
      label: "See your devices",
      url: appLink(input.origin, productRoute(input.productSlug, "devices")),
    },
    origin: input.origin,
  });
}

/** "4 Oct 2026, 14:34 UTC": a unix time for a sentence in an email. */
function emailDate(at: number): string {
  const d = new Date(at * 1000);
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][d.getUTCMonth()]!;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

// ── Key ring (U-36.3; WIRE-CONTRACT-V5 §13.11, THREAT-MODEL T23) ─────────────────────────────

const RING_NO_ASK = "No one will ask you for your recovery code.";

interface RingNoticeInput {
  deviceLabel: string | null | undefined;
  productName: string | null | undefined;
  productSlug: string;
  at: number;
  origin: string;
}

/** "See your devices" and the secure link, for a notice about a device of the account. */
function devicesLinks(input: { productSlug: string; origin: string }) {
  return {
    action: {
      label: "See your devices",
      url: appLink(input.origin, productRoute(input.productSlug, "devices")),
    },
    secureUrl: appLink(input.origin, "account/methods"),
  };
}

/** The three key ring notices share their shape: copy, "See your devices", the secure link. */
function ringNotice(
  input: RingNoticeInput,
  help: string,
  copy: (
    device: string,
    name: string,
    when: string,
  ) => {
    subject: string;
    paragraphs: string[];
  },
): NoticeMessage {
  const device = displayValue(input.deviceLabel, "");
  const name = displayValue(input.productName, "your product");
  const { subject, paragraphs } = copy(device, name, emailDate(input.at));
  return buildNotice({
    help,
    subject,
    paragraphs: [...paragraphs, RING_NO_ASK],
    ...devicesLinks(input),
    origin: input.origin,
  });
}

/** A device fetched the recovery data: "Recovery started on Studio PC". */
export function recoveryStartedNotice(input: RingNoticeInput): NoticeMessage {
  return ringNotice(input, "recovery-started", (device, name, when) => ({
    subject: `Recovery started on ${device || "a device"}`,
    paragraphs: [
      `${device || "A device"} started recovering your ${name} data on ${when}. Enter your recovery code in ${name} only.`,
    ],
  }));
}

/** The recovery code was replaced: the old code no longer opens the data. */
export function recoveryCodeChangedNotice(
  input: RingNoticeInput,
): NoticeMessage {
  return ringNotice(input, "recovery-code-changed", (device, name, when) => ({
    subject: `Your ${name} recovery code changed`,
    paragraphs: [
      `${device || "A device"} made a new recovery code for your ${name} data on ${when}. The old code no longer works.`,
    ],
  }));
}

/** Encryption was reset: new key, new code; the old key's data moves over for 30 days. */
export function encryptionResetNotice(input: RingNoticeInput): NoticeMessage {
  return ringNotice(input, "encryption-reset", (device, name, when) => ({
    subject: `${name} encryption was reset`,
    paragraphs: [
      `${device || "A device"} reset the encryption for your ${name} data on ${when}. There is a new key and a new recovery code.`,
      "A device that still has the old key can move your data over for 30 days. After that it can't be recovered.",
    ],
  }));
}

/**
 * A new device signed in to the account (SIGN-IN.md §3.15): `signin.mail.newDevice.subject`,
 * `signin.mail.newDevice.body` and **Open Polaris Locker** (`signin.mail.open`).
 */
export function newDeviceSignInNotice(input: {
  deviceLabel: string | null | undefined;
  /** An approximate place, when the sign-in had one ("Lisbon, Portugal"). */
  location?: string | null;
  /** When it signed in (unix seconds), for "signed in on {date}". */
  at?: number;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "A new device");
  const location = input.location ? displayValue(input.location, "") : "";
  const when = input.at !== undefined ? ` on ${emailDate(input.at)}` : "";
  const where = location ? ` from ${location}` : "";
  return buildNotice({
    help: "new-device-sign-in",
    subject: "A new device signed in to your Polaris Locker account", // signin.mail.newDevice.subject
    paragraphs: [
      // signin.mail.newDevice.body
      `${device} signed in${when}${where}. If this wasn't you, sign it out in Polaris Locker under Where you're signed in.`,
    ],
    action: {
      label: "Open Polaris Locker", // signin.mail.open
      url: appLink(input.origin, "account/sessions"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/**
 * F-37.1b: a read-only personal token was handed to `pkey` (`pkey feeds setup --write`), approved
 * in Polaris Locker. The remedy is Locker's Packages page. `host` is the CLI's own words (unverified).
 */
export function packagesTokenNotice(input: {
  host: string | null | undefined;
  location?: string | null;
  at?: number;
  origin: string;
}): NoticeMessage {
  const host = displayValue(input.host, "a computer");
  const location = input.location ? displayValue(input.location, "") : "";
  const when = input.at !== undefined ? ` on ${emailDate(input.at)}` : "";
  const where = location ? ` from about ${location}` : "";
  return buildNotice({
    help: "packages-token",
    subject: "A personal token was created for your Polaris Locker account",
    paragraphs: [
      `pkey on ${host} got a read-only personal token${when}${where}. If this wasn't you, revoke it in Polaris Locker, under Packages.`,
    ],
    action: {
      label: "Open Polaris Locker",
      url: appLink(input.origin, "account/packages"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/**
 * ST-34.6 (D-17): a command line (`pkey login`) was approved as the person in the Polaris Key
 * console (an operator notice, not a Locker one). The remedy is the console's Personal
 * tokens (or a Superadmin), never Locker's sessions page. `origin` is the console's.
 */
export function cliSignInNotice(input: {
  /** "pkey on <host>": the CLI's own words, unverified. */
  deviceLabel: string | null | undefined;
  location?: string | null;
  at?: number;
  origin: string;
}): NoticeMessage {
  const device = displayValue(input.deviceLabel, "A command line");
  const location = input.location ? displayValue(input.location, "") : "";
  const when = input.at !== undefined ? ` on ${emailDate(input.at)}` : "";
  const where = location ? ` from about ${location}` : "";
  return buildNotice({
    subject: "A command line signed in to the Polaris Key console as you",
    paragraphs: [
      `${device} was approved as you in the Polaris Key console${when}${where}. Its token lasts ${PERSONAL_TOKEN_DAYS.admin.default} days and can do what your roles allow.`,
      "If this wasn't you, end it under Personal tokens in the console, or ask a Superadmin to.",
    ],
    action: { label: "Open the console", url: `${input.origin}/manage/` },
    footer:
      "You are receiving this because a command-line sign-in was approved with your Polaris Key console access. We sent it to every verified email on the account.",
    origin: input.origin,
    brand: "key",
  });
}

/** A sign-in method was connected: "Steam was connected to your Polaris Locker account". */
export function signInMethodAddedNotice(input: {
  /** The method by its own name: "Apple", "Google", "Steam", "A passkey", an email address. */
  method: string;
  origin: string;
  /** The app that made the link (the link offer, I-43.2); absent for a link made in the portal. */
  app?: string | undefined;
}): NoticeMessage {
  const method = displayValue(input.method, "A sign-in method");
  const app = input.app ? displayValue(input.app, "an app") : null;
  return buildNotice({
    help: "sign-in-method-added",
    subject: `${method} was connected to your Polaris Locker account`,
    paragraphs: [
      app
        ? `${method} was added in ${app} as a way to sign in to your Polaris Locker account.`
        : `${method} was added as a way to sign in to your Polaris Locker account.`,
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A sign-in method was removed: "Steam was disconnected from your Polaris Locker account". */
export function signInMethodRemovedNotice(input: {
  method: string;
  origin: string;
}): NoticeMessage {
  const method = displayValue(input.method, "A sign-in method");
  return buildNotice({
    help: "sign-in-method-removed",
    subject: `${method} was disconnected from your Polaris Locker account`,
    paragraphs: [
      `${method} can no longer be used to sign in to your Polaris Locker account.`,
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The primary email changed. Names no address: it goes to every verified one (PX-W19). */
export function primaryEmailChangedNotice(input: {
  origin: string;
}): NoticeMessage {
  return buildNotice({
    help: "primary-email-changed",
    subject: "Your Polaris Locker primary email was changed",
    paragraphs: [
      "Another verified email on your Polaris Locker account is now its primary. Security notices and the email apps see for you now go there.",
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The account holder scheduled a reversible, self-service deletion. */
export function accountDeletionScheduledNotice(input: {
  origin: string;
  dueAt: number;
}): NoticeMessage {
  return buildNotice({
    help: "account-deletion-scheduled",
    subject: "Your Polaris Locker account is scheduled for deletion",
    paragraphs: [
      "Your Polaris Locker account is scheduled to be erased unless you cancel the deletion before then.",
      "Your account stays active during that 14-day period. Deleting it does not cancel your licenses: they stay with each developer, and you can add them again with a new account.",
    ],
    callout: `Erased on ${utcInstant(input.dueAt)}.`,
    action: {
      label: "Review account settings",
      url: appLink(input.origin, "account/data"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The account holder cancelled a scheduled self-service deletion. */
export function accountDeletionCancelledNotice(input: {
  origin: string;
}): NoticeMessage {
  return buildNotice({
    help: "account-deletion-cancelled",
    subject: "Your Polaris Locker account deletion was canceled",
    paragraphs: [
      "Your Polaris Locker account will stay active. No account data will be erased.",
    ],
    action: {
      label: "Review account settings",
      url: appLink(input.origin, "account/data"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** The account was deleted at the holder's request (sent before the rows go). */
export function accountDeletedNotice(input: { origin: string }): NoticeMessage {
  return buildNotice({
    help: "account-deleted",
    subject: "Your Polaris Locker account has been deleted",
    paragraphs: [
      "Your Polaris Locker account, its email addresses and its sign-in methods have been erased, as you asked.",
      "Deleting it doesn't cancel your licenses: they stay with each developer, and you can add them again with a new account. To have a developer erase its own records, contact that developer's support.",
    ],
    footer:
      "You are receiving this because your Polaris Locker account was deleted. " +
      "We sent it to every verified email on the account.",
    origin: input.origin,
  });
}

// ── Accounts (I-05) ──────────────────────────────────────────────────────────────────────────

/** A unix time as a readable UTC instant for a notice: "2026-10-04 14:34 UTC". */
function utcInstant(at: number): string {
  return `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Two accounts were joined into one, after the person signed in to both (S-16 §5.1, D21). With
 * `undoUntil` (PX-W12) it says until when the join can be undone, and where.
 */
export function accountsMergedNotice(input: {
  origin: string;
  undoUntil?: number;
}): NoticeMessage {
  return buildNotice({
    help: "accounts-merged",
    subject: "Two Polaris Locker accounts were joined",
    paragraphs: [
      "Two Polaris Locker accounts were joined into one after someone signed in to both. Their sign-in methods and licenses are now on a single account.",
      ...(input.undoUntil === undefined
        ? []
        : [
            `You can separate them again until ${utcInstant(input.undoUntil)} from Account → Sign-in methods.`,
          ]),
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

/** A join was undone within its 72 hours (PX-W12): two accounts again. */
export function accountsSeparatedNotice(input: {
  origin: string;
}): NoticeMessage {
  return buildNotice({
    help: "accounts-separated",
    subject: "Your Polaris Locker accounts were separated",
    paragraphs: [
      "Two Polaris Locker accounts that were joined are separate again. Each has its own sign-in methods and licenses back, as they were before the join.",
    ],
    action: {
      label: "See your sign-in methods",
      url: appLink(input.origin, "account/methods"),
    },
    secureUrl: appLink(input.origin, "account/methods"),
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
    help: "license-relinked-away",
    subject: `The developer moved your ${name} license to another account`,
    paragraphs: [
      `The developer of ${name} moved one of its licenses from your Polaris Locker account to another account, at the request of its support.`,
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
    help: "license-relinked-in",
    subject: `${name} is being added to your library`,
    paragraphs: [
      `The developer of ${name} moved one of its licenses to your Polaris Locker account, at the request of its support.`,
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
    help: "license-relink-undone",
    subject: `The developer undid a move of a ${name} license`,
    paragraphs: [
      `The developer of ${name} undid an earlier move of one of its licenses. The license goes back to the account it came from.`,
      "If you did not expect this, contact the developer's support.",
    ],
    secureUrl: appLink(input.origin, "account/methods"),
    origin: input.origin,
  });
}

// ── Holder moves (LX-30; notes/S-24 §5.5, D20) ───────────────────────────────────────────────
//
// Make floating and Reassign… are the relink tool's two holder moves. The side the licence leaves
// is told before the move (with the undo window), at every verified email of its account when it
// was in one, or at the licence's own address when it was waiting for one. A waiting address has
// no Polaris Locker account, so its variant carries no "Secure your account" link and says why the
// message came. The new address is told the licence is waiting for it, and never whether an
// account already holds that address (S-24 D4).

/** Why a message reached an address that has no account: the developer issued a licence to it. */
const LICENSE_ADDRESS_FOOTER =
  "You are receiving this because a developer issued a license to this email address.";

/** The away side of a holder move: an account (security notice) or a waiting licence's address. */
function holderMovedAwayNotice(input: {
  help: string;
  subject: string;
  paragraph: string;
  inAccount: boolean;
  origin: string;
}): NoticeMessage {
  const undo = `If you did not expect this, contact the developer's support now: they can undo it for ${RELINK_UNDO_WORDS}.`;
  return buildNotice({
    help: input.help,
    subject: input.subject,
    paragraphs: [input.paragraph, undo],
    ...(input.inAccount
      ? { secureUrl: appLink(input.origin, "account/methods") }
      : { footer: LICENSE_ADDRESS_FOOTER }),
    origin: input.origin,
  });
}

/**
 * Make floating: the developer took the licence off its holder. It keeps working on every device
 * that has its key; it is no longer in anyone's library.
 */
export function licenseMadeFloatingNotice(input: {
  productName: string | null | undefined;
  /** True: sent to the account the licence leaves. False: to a waiting licence's address. */
  inAccount: boolean;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "product");
  const dev = displayValue(input.productName, "this product");
  return holderMovedAwayNotice({
    help: "license-made-floating",
    subject: input.inAccount
      ? `The developer removed a ${name} license from your account`
      : `A ${name} license is no longer assigned to you`,
    paragraph: input.inAccount
      ? `The developer of ${dev} removed one of its licenses from your Polaris Locker account, at the request of its support. It is no longer in your library.`
      : `The developer of ${dev} removed your name and email address from one of its licenses, at the request of its support.`,
    inAccount: input.inAccount,
    origin: input.origin,
  });
}

/** Reassign…: the developer gave the licence to someone else. */
export function licenseReassignedAwayNotice(input: {
  productName: string | null | undefined;
  inAccount: boolean;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "product");
  const dev = displayValue(input.productName, "this product");
  return holderMovedAwayNotice({
    help: "license-reassigned-away",
    subject: `The developer assigned your ${name} license to someone else`,
    paragraph: input.inAccount
      ? `The developer of ${dev} assigned one of its licenses in your Polaris Locker account to someone else, at the request of its support. It is no longer in your library.`
      : `The developer of ${dev} assigned one of its licenses, issued to this email address, to someone else, at the request of its support.`,
    inAccount: input.inAccount,
    origin: input.origin,
  });
}

/**
 * Reassign…, the receiving side: sent to the new address only. Never says whether an account
 * holds that address (S-24 D4): the same words whether the licence is waiting or already joined.
 */
export function licenseAssignedToYouNotice(input: {
  productName: string | null | undefined;
  productSlug: string;
  origin: string;
}): NoticeMessage {
  const name = displayValue(input.productName, "product");
  const dev = displayValue(input.productName, "this product");
  return buildNotice({
    help: "license-assigned-to-you",
    subject: `A ${name} license was assigned to you`,
    paragraphs: [
      `The developer of ${dev} assigned one of its licenses to this email address.`,
      "Sign in to Polaris Locker with this email address to find it in your library.",
    ],
    action: {
      label: `Open ${displayValue(input.productName, "it")}`,
      url: appLink(input.origin, productRoute(input.productSlug)),
    },
    footer: LICENSE_ADDRESS_FOOTER,
    origin: input.origin,
  });
}

// ── Operator notices (Polaris Key, the console side) ─────────────────────────────────────────

/**
 * Writer-controlled text (an inviter's display name, a product name) in a mail from the Polaris
 * Key sender to an address the writer chose (ST-31.7 N3). {@link displayValue}, then: a URL scheme
 * is dropped and the dot of a domain-like token is defanged (`example[.]com`), so a mail client
 * does not auto-link it and the sender's reputation does not carry a phishing line.
 */
export function operatorText(
  raw: string | null | undefined,
  fallback: string,
): string {
  return displayValue(raw, fallback)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\/*/gi, "")
    .replace(/(?<=[\p{L}\p{N}-])\.(?=\p{L}{2,})/gu, "[.]");
}

/**
 * ST-31.6 (ST-28 G5): a console role was granted, changed or taken back. Sent as Polaris Key
 * (`sender.audience: "operator"`) to the person it concerns and to every Superadmin, so a stolen
 * session that hands out access cannot do it silently. It names the role, the scope, the areas
 * and who did it, and carries no link and no token: the reader opens the console themselves.
 */
export function accessChangedNotice(input: {
  change: "granted" | "changed" | "revoked";
  /** The person whose access changed (a display name or address). */
  member: string | null | undefined;
  actor: string | null | undefined;
  /** `Product admin`, `Console access`, …: the role's name. */
  roleLabel: string;
  /** `all products`, `the platform` or a product's name. */
  scopeLabel: string | null | undefined;
  /** `null` = every area (or an area-less role). */
  areas: readonly string[] | null;
  origin: string | null | undefined;
}): NoticeMessage {
  const member = operatorText(input.member, "A member");
  const actor = operatorText(input.actor, "An operator");
  const scope = operatorText(input.scopeLabel, "the platform");
  const verb =
    input.change === "granted"
      ? "was given"
      : input.change === "changed"
        ? "now has changed access as"
        : "no longer has";
  const subject = `Access changed: ${member}`;
  const line =
    input.change === "changed"
      ? `${actor} changed ${member}'s access: ${member} is ${input.roleLabel} on ${scope}${
          input.areas ? `, limited to ${input.areas.join(", ")}` : ""
        }.`
      : `${actor} changed who can use the Polaris Key console: ${member} ${verb} ${input.roleLabel} on ${scope}${
          input.areas && input.change === "granted"
            ? `, limited to ${input.areas.join(", ")}`
            : ""
        }.`;
  const footer =
    "You get this because you are a Superadmin, or because the change is to your own access. " +
    "If you did not expect it, open Members in the console and take the access back.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line],
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}

/**
 * ST-32.5 (ST-28 G5): the SSO access rules (`console.access`) changed. Sent as Polaris Key to every
 * Superadmin, so a stolen session cannot widen who gets in without the others hearing. It names
 * who did it and what the rules now say in general terms, never a group or a person.
 */
export function accessRulesNotice(input: {
  actor: string | null | undefined;
  /** `added` for one rule, `changed` for any other edit, `cleared` for a reset. */
  change: "added" | "changed" | "cleared";
  /** How many rules are stored after the change. */
  ruleCount: number;
  origin: string | null | undefined;
}): NoticeMessage {
  const actor = operatorText(input.actor, "An operator");
  const subject = "Sign-in rules changed";
  const what =
    input.change === "added"
      ? "added a sign-in rule"
      : input.change === "cleared"
        ? "removed every sign-in rule"
        : "changed the sign-in rules";
  const line = `${actor} ${what}. Rules now stored: ${input.ruleCount}. A rule gives console access to people who sign in through a company identity provider.`;
  const footer =
    "You get this because you are a Superadmin. " +
    "If you did not expect it, open Members in the console and remove the rule.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      paragraphs: [line],
      heading: subject,
      origin: emailAssetOrigin(input.origin),
      footer,
    }),
  };
}

/** The invite's link: the console sign-in page with the address as a hint. No secret, no token. */
export function consoleInviteLink(
  origin: string | null | undefined,
  email: string,
): string {
  const base = (origin ?? "").replace(/\/+$/, "");
  return `${base}/manage/login?login_hint=${encodeURIComponent(email)}`;
}

/**
 * ST-31.7: an invite to the console, sent as Polaris Key to the invited address only. The link is
 * the sign-in page with the address as a hint and carries nothing that lets anyone in: access
 * follows a sign-in that proves this address, so a forwarded mail grants nothing. It says who
 * invited, the role, the scope and the areas, and that it lapses.
 */
export function accessInviteNotice(input: {
  inviter: string | null | undefined;
  roleLabel: string;
  scopeLabel: string | null | undefined;
  areas: readonly string[] | null;
  link: string;
  origin: string | null | undefined;
}): NoticeMessage {
  const inviter = operatorText(input.inviter, "An operator");
  const scope = operatorText(input.scopeLabel, "the platform");
  const subject = "You are invited to the Polaris Key console";
  const line = `${inviter} invited you to the Polaris Key console as ${input.roleLabel} on ${scope}${
    input.areas ? `, limited to ${input.areas.join(", ")}` : ""
  }.`;
  const how =
    "Sign in with this email address to accept. The invitation lapses after 7 days.";
  const footer =
    "The link only opens the sign-in page. It does not give access by itself. " +
    "If you did not expect this, ignore this email.";
  return {
    subject,
    text: [subject, line, how, `Sign in: ${input.link}`, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line, how],
      action: { label: "Sign in", url: input.link },
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}

/**
 * ST-31.8: an invitation was accepted (the invitee signed in and the invite became their access).
 * Sent as Polaris Key to the inviter and to every Superadmin. Names the role, the scope, the areas
 * and who invited; carries no link and no token.
 */
export function accessInviteAcceptedNotice(input: {
  /** The person who signed in (a display name or address). */
  member: string | null | undefined;
  inviter: string | null | undefined;
  roleLabel: string;
  scopeLabel: string | null | undefined;
  areas: readonly string[] | null;
  origin: string | null | undefined;
}): NoticeMessage {
  const member = operatorText(input.member, "A member");
  const inviter = operatorText(input.inviter, "An operator");
  const scope = operatorText(input.scopeLabel, "the platform");
  const subject = `Console invitation accepted: ${member}`;
  const line = `${member} signed in to the Polaris Key console with the invitation from ${inviter} and is now ${input.roleLabel} on ${scope}${
    input.areas ? `, limited to ${input.areas.join(", ")}` : ""
  }.`;
  const footer =
    "You get this because you sent the invitation or you are a Superadmin. " +
    "If you did not expect it, open Members in the console and take the access back.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line],
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}

/**
 * ST-31.7 (G5 for invites): one notice per request to every Superadmin, so a session that hands
 * out invites is loud. Counts only; it names no invited address.
 */
export function accessInvitesSentNotice(input: {
  actor: string | null | undefined;
  count: number;
  roleLabel: string;
  scopeLabel: string | null | undefined;
  areas: readonly string[] | null;
  origin: string | null | undefined;
}): NoticeMessage {
  const actor = operatorText(input.actor, "An operator");
  const scope = operatorText(input.scopeLabel, "the platform");
  const subject = `Console invitations sent: ${input.count}`;
  const line = `${actor} invited ${input.count} ${input.count === 1 ? "person" : "people"} to the Polaris Key console as ${input.roleLabel} on ${scope}${
    input.areas ? `, limited to ${input.areas.join(", ")}` : ""
  }.`;
  const footer =
    "You get this because you are a Superadmin. If you did not expect it, open Members in the console and cancel the invitations.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line],
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}

/**
 * ST-30c.1: the break-glass (emergency sign-in) console sign-in was used. Sent as Polaris Key to every Superadmin on
 * every use. Names who, when and from which network; carries no link and no token.
 */
export function breakGlassUsedNotice(input: {
  /** The identity that signed in (an address or the IdP subject). */
  who: string | null | undefined;
  /** When, epoch seconds. */
  at: number;
  /** The caller's network as the limiter sees it, when known. */
  network: string | null | undefined;
  origin: string | null | undefined;
}): NoticeMessage {
  const who = operatorText(input.who, "An operator");
  const when = new Date(input.at * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const from = input.network ? ` from ${displayValue(input.network, "")}` : "";
  const subject = "Emergency sign-in used";
  const line = `${who} used emergency sign-in to the Polaris Key console at ${when}${from}.`;
  const footer =
    "You get this because you are a Superadmin. If this wasn't expected, rotate ADMIN_SESSION_SECRET and check the audit.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line],
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}

/**
 * ST-30c.3 (SM-3): a passkey now opens the console; sent to the account that did it and to every
 * Superadmin. Names who and when; carries no link and no credential detail.
 */
export function consoleMethodStrongNotice(input: {
  /** Who did it (name or address). */
  actor: string | null | undefined;
  /** Epoch seconds. */
  at: number;
  /** The account's own copy ("you") or the Superadmins'. */
  audience: "self" | "superadmin";
  origin: string | null | undefined;
}): NoticeMessage {
  const actor = operatorText(input.actor, "An operator");
  const when = new Date(input.at * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const subject = "A passkey can now open the Polaris Key console";
  const line =
    input.audience === "self"
      ? `A passkey on your account was set to open the Polaris Key console at ${when}.`
      : `${actor} set a passkey to open the Polaris Key console at ${when}.`;
  const footer =
    input.audience === "self"
      ? "If this wasn't you, sign in to your Polaris Locker account and remove that passkey, then tell a Superadmin."
      : "You get this because you are a Superadmin. If this wasn't expected, check the audit for rbac.method_strong.";
  return {
    subject,
    text: [subject, line, footer].join("\n\n"),
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [line],
      footer,
      origin: emailAssetOrigin(input.origin),
    }),
  };
}
