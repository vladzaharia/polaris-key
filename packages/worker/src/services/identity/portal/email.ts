/**
 * Polaris Key account email: the branded renderer, the magic sign-in link and the transport for the
 * account notices (whose copy lives in `notices.ts`).
 *
 * Every message carries a plain-text part (the canonical copy; clients that refuse HTML show
 * it) and a branded HTML part built by `renderEmail` to docs/design/BRAND.md §2 ("Emails"):
 *
 *   - table layout with inline styles only, so it survives clients that strip `<style>`;
 *   - colours inlined from the brand theme tokens (light ground by default, the platform violet
 *     as the one accent), with a dark palette in a `prefers-color-scheme: dark` block for the
 *     clients that honour it, and `color-scheme` metadata so the rest can adapt it themselves;
 *   - the kit's horizontal PNG lockup (PORTAL.md §6.3; no "Powered by" badge), the 944 px 2x
 *     file shown at 472 x 160, linked from the console origin's `/assets/branding/key/` (emitted
 *     there by packages/admin/vite.config.ts) with `alt="Polaris Key"`. The `light` variant (for
 *     light grounds) is the default; the dark palette swaps in the `dark` variant for the clients
 *     that apply it. With no usable origin the lockup is left out and a text wordmark stands in;
 *   - every dynamic value escaped; links are only the ones the Worker built.
 */

import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import type { Db, Env } from "../../../core/platform.js";
import type { NoticeMessage } from "./notices.js";
import { listVerifiedAccountEmails } from "./repo.js";

function fromAddress(env: Env): string {
  return env.PORTAL_EMAIL_FROM ?? "Polaris Key <noreply@plrs.im>";
}

export function portalEmailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** An `https:` origin (or `http:` on loopback, for local development) to load the lockup from. */
export function emailAssetOrigin(
  ...candidates: (string | null | undefined)[]
): string | null {
  for (const raw of candidates) {
    if (typeof raw !== "string" || raw.trim() === "") continue;
    try {
      const u = new URL(raw);
      const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1";
      if (u.protocol === "https:" || (u.protocol === "http:" && loopback))
        return u.origin;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

const LIGHT = THEME_TOKENS.light;
const DARK = THEME_TOKENS.dark;

/**
 * The dark palette, for clients that apply `prefers-color-scheme` (Apple Mail, iOS Mail,
 * Outlook for Mac, some Android clients). `[data-ogsc]` repeats it for Outlook.com's dark mode.
 * Clients that strip `<style>` keep the inline light palette, and may invert it themselves.
 */
function darkCss(): string {
  const rules = [
    `.pk-bg{background-color:${DARK.surface.page} !important}`,
    `.pk-card{background-color:${DARK.surface.raised} !important;border-color:${DARK.border.subtle} !important}`,
    `.pk-strong{color:${DARK.text.strong} !important}`,
    `.pk-text{color:${DARK.text.default} !important}`,
    `.pk-muted{color:${DARK.text.muted} !important}`,
    `.pk-btn{background-color:${DARK.accent.violet.solid} !important}`,
    `.pk-btn-a{color:${DARK.accent.violet.on} !important}`,
    `.pk-link{color:${DARK.accent.violet.fg} !important}`,
    `.pk-logo-light{display:none !important}`,
    `.pk-logo-dark{display:block !important;max-height:none !important}`,
  ];
  return (
    `@media (prefers-color-scheme: dark){${rules.join("")}}` +
    rules.map((r) => `[data-ogsc] ${r}`).join("")
  );
}

export interface EmailContent {
  /** The subject, also the HTML `<title>`. */
  subject: string;
  /** The heading in the card. */
  heading: string;
  /** Body paragraphs, plain text (escaped here; line breaks kept). */
  paragraphs: string[];
  /** One call to action, a URL the Worker built. */
  action?: { label: string; url: string };
  /** A security notice's "Wasn't you? Secure your account" line, a URL the Worker built. */
  secure?: { label: string; url: string };
  /** The small print under the card. Plain text. */
  footer: string;
  /** The origin to load the lockup from, or null to use a text wordmark instead. */
  origin: string | null;
}

/** The branded HTML part of an email. */
export function renderEmail(c: EmailContent): string {
  const font = FONT.sans.replace(/"/g, "'");
  const mono = FONT.mono.replace(/"/g, "'");
  const para = (
    text: string,
    cls = "pk-text",
    color: string = LIGHT.text.default,
  ) =>
    `<p class="${cls}" style="margin:0 0 16px;font-family:${font};font-size:16px;line-height:24px;color:${color}">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const lockup = (variant: "light" | "dark", style: string) =>
    `<img class="pk-logo-${variant}" src="${escapeHtml(`${c.origin}/assets/branding/key/key-horizontal-${variant}-944.png`)}" width="472" height="160" alt="Polaris Key" style="${style}">`;
  const imgStyle =
    "width:472px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none";
  const brand = c.origin
    ? lockup("light", `display:block;${imgStyle}`) +
      // Hidden unless the dark palette applies (`mso-hide` for Outlook on Windows).
      `<!--[if !mso]><!-->${lockup("dark", `display:none;max-height:0;overflow:hidden;mso-hide:all;${imgStyle}`)}<!--<![endif]-->`
    : `<p class="pk-strong" style="margin:0;font-family:${font};font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.text.light}">Polaris Key</p>`;
  const action = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td class="pk-btn" bgcolor="${LIGHT.accent.violet.solid}" style="border-radius:6px;background-color:${LIGHT.accent.violet.solid}"><a class="pk-btn-a" href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:12px 24px;font-family:${font};font-size:16px;line-height:20px;font-weight:700;color:${LIGHT.accent.violet.on};text-decoration:none;border-radius:6px">${escapeHtml(c.action.label)}</a></td></tr></table>` +
      para(
        "If the button does not work, paste this link into your browser:",
        "pk-muted",
        LIGHT.text.muted,
      ) +
      `<p style="margin:0;font-family:${mono};font-size:13px;line-height:20px;word-break:break-all"><a class="pk-link" href="${escapeHtml(c.action.url)}" style="color:${LIGHT.accent.violet.fg};text-decoration:underline">${escapeHtml(c.action.url)}</a></p>`
    : "";
  const secure = c.secure
    ? `<p class="pk-text" style="margin:24px 0 0;font-family:${font};font-size:15px;line-height:22px;color:${LIGHT.text.default}"><strong>Wasn&#x27;t you?</strong> <a class="pk-link" href="${escapeHtml(c.secure.url)}" style="color:${LIGHT.accent.violet.fg};text-decoration:underline">${escapeHtml(c.secure.label)}</a></p>`
    : "";
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="color-scheme" content="light dark">`,
    `<meta name="supported-color-schemes" content="light dark">`,
    `<title>${escapeHtml(c.subject)}</title>`,
    `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}body{margin:0;padding:0}${darkCss()}</style>`,
    `</head>`,
    `<body class="pk-bg" style="margin:0;padding:0;background-color:${LIGHT.surface.page}">`,
    `<table role="presentation" class="pk-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.surface.page}" style="width:100%;background-color:${LIGHT.surface.page}">`,
    `<tr><td align="center" style="padding:32px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px">`,
    // The lockup PNG carries its own clear space; the text wordmark needs the gap.
    `<tr><td style="padding:0 0 ${c.origin ? 0 : 24}px">${brand}</td></tr>`,
    `<tr><td class="pk-card" bgcolor="${LIGHT.surface.raised}" style="padding:32px;background-color:${LIGHT.surface.raised};border:1px solid ${LIGHT.border.subtle};border-radius:10px">`,
    `<h1 class="pk-strong" style="margin:0 0 16px;font-family:${font};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${LIGHT.text.strong}">${escapeHtml(c.heading)}</h1>`,
    ...c.paragraphs.map((t) => para(t)),
    action,
    secure,
    `</td></tr>`,
    `<tr><td class="pk-muted" style="padding:24px 8px 0;font-family:${font};font-size:13px;line-height:20px;color:${LIGHT.text.muted}">${escapeHtml(c.footer)}</td></tr>`,
    `</table>`,
    `</td></tr>`,
    `</table>`,
    `</body>`,
    `</html>`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export async function sendMagicLink(
  env: Env,
  to: string,
  link: string,
): Promise<boolean> {
  const email = env.EMAIL;
  if (!email) return false;
  const subject = "Sign in to Polaris Key";
  await email.send({
    from: fromAddress(env),
    to,
    subject,
    text:
      `Use this link to sign in to Polaris Key:\n\n${link}\n\n` +
      `This link expires in 10 minutes and works once. If you did not ask to sign in, you can ignore this email.`,
    html: renderEmail({
      subject,
      heading: "Sign in to Polaris Key",
      paragraphs: [
        "Use the button below to sign in. The link expires in 10 minutes and works once.",
      ],
      action: { label: "Sign in", url: link },
      footer:
        "If you did not ask to sign in, you can ignore this email. Nothing changes until the link is used.",
      origin: emailAssetOrigin(link, env.CONSOLE_ORIGIN),
    }),
  });
  return true;
}

/** One notice to one address. No binding or no address: nothing is sent. */
export async function sendNotice(
  env: Env,
  to: string | null | undefined,
  message: NoticeMessage,
): Promise<void> {
  if (!to || !env.EMAIL) return;
  await env.EMAIL.send({ from: fromAddress(env), to, ...message });
}

/**
 * A security notice (PORTAL.md §6.3): one message per address, to every verified email on the
 * account plus `alsoTo` (the session's address, which a brand-new account may not have verified
 * a row for yet). Sent separately, so no recipient learns the account's other addresses.
 *
 * A failed send is caught per recipient and never fails the change it reports (a device is
 * already removed, an account is about to be erased); the others still go out. Returns how many
 * were sent. The log line carries counts only, never an address.
 */
export async function sendSecurityNotice(
  env: Env,
  db: Db,
  accountId: string,
  alsoTo: string | null | undefined,
  message: NoticeMessage,
): Promise<number> {
  if (!env.EMAIL) return 0;
  const recipients = await securityNoticeRecipients(db, accountId, alsoTo);
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendNotice(env, to, message);
      sent += 1;
    } catch {
      // counted below
    }
  }
  if (sent < recipients.length) {
    console.warn(
      `security notice: ${recipients.length - sent} of ${recipients.length} sends failed`,
    );
  }
  return sent;
}

/** Every verified address on the account, plus `alsoTo`, de-duplicated case-insensitively. */
export async function securityNoticeRecipients(
  db: Db,
  accountId: string,
  alsoTo: string | null | undefined,
): Promise<string[]> {
  const seen = new Map<string, string>();
  for (const email of [
    ...(await listVerifiedAccountEmails(db, accountId)),
    ...(alsoTo ? [alsoTo] : []),
  ]) {
    const key = email.trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, email.trim());
  }
  return [...seen.values()];
}
