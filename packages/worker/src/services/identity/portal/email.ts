/**
 * The portal's email: the magic sign-in link and the account notices.
 *
 * Every message carries a plain-text part (the canonical copy; clients that refuse HTML show
 * it) and a branded HTML part built by `renderEmail` to docs/design/BRAND.md §2 ("Emails"):
 *
 *   - table layout with inline styles only, so it survives clients that strip `<style>`;
 *   - colours inlined from the brand theme tokens (light ground by default, the platform violet
 *     as the one accent), with a dark palette in a `prefers-color-scheme: dark` block for the
 *     clients that honour it, and `color-scheme` metadata so the rest can adapt it themselves;
 *   - the Pinned K as the kit's PNG app icon (no bit, on its own plate, so a client that inverts
 *     or replaces the background cannot lose it), the 180 px file shown at 40 px, linked from
 *     the console origin's `/assets/branding/key/`; empty `alt`, because the wordmark beside it
 *     is text. With no usable origin the icon is left out and the wordmark stands alone;
 *   - every dynamic value escaped; links are only the ones the Worker built.
 */

import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import type { Env } from "../../../core/platform.js";

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

/** An `https:` origin (or `http:` on loopback, for local development) to load the icon from. */
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
  /** The small print under the card. Plain text. */
  footer: string;
  /** The origin to load the icon from, or null to leave it out. */
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
  const icon = c.origin
    ? `<td width="40" style="width:40px;padding:0 12px 0 0;vertical-align:middle"><img src="${escapeHtml(`${c.origin}/assets/branding/key/app-icon-dark-180.png`)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border:0;border-radius:9px"></td>`
    : "";
  const brand = `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${icon}<td class="pk-strong" style="vertical-align:middle;font-family:${font};font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.text.light}">Polaris Key</td></tr></table>`;
  const action = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td class="pk-btn" bgcolor="${LIGHT.accent.violet.solid}" style="border-radius:6px;background-color:${LIGHT.accent.violet.solid}"><a class="pk-btn-a" href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:12px 24px;font-family:${font};font-size:16px;line-height:20px;font-weight:700;color:${LIGHT.accent.violet.on};text-decoration:none;border-radius:6px">${escapeHtml(c.action.label)}</a></td></tr></table>` +
      para(
        "If the button does not work, paste this link into your browser:",
        "pk-muted",
        LIGHT.text.muted,
      ) +
      `<p style="margin:0;font-family:${mono};font-size:13px;line-height:20px;word-break:break-all"><a class="pk-link" href="${escapeHtml(c.action.url)}" style="color:${LIGHT.accent.violet.fg};text-decoration:underline">${escapeHtml(c.action.url)}</a></p>`
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
    `<tr><td style="padding:0 0 24px">${brand}</td></tr>`,
    `<tr><td class="pk-card" bgcolor="${LIGHT.surface.raised}" style="padding:32px;background-color:${LIGHT.surface.raised};border:1px solid ${LIGHT.border.subtle};border-radius:10px">`,
    `<h1 class="pk-strong" style="margin:0 0 16px;font-family:${font};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${LIGHT.text.strong}">${escapeHtml(c.heading)}</h1>`,
    ...c.paragraphs.map((t) => para(t)),
    action,
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

const NOTICE_FOOTER =
  "You are receiving this because of a change to your Polaris Key account.";

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

export async function sendPortalNotice(
  env: Env,
  to: string | null | undefined,
  subject: string,
  text: string,
): Promise<void> {
  if (!to || !env.EMAIL) return;
  await env.EMAIL.send({
    from: fromAddress(env),
    to,
    subject,
    text,
    html: renderEmail({
      subject,
      heading: subject,
      paragraphs: [text],
      footer: NOTICE_FOOTER,
      origin: emailAssetOrigin(env.CONSOLE_ORIGIN),
    }),
  });
}
