/**
 * The branded email renderer (docs/design/BRAND.md §2, "Emails"): `renderEmail` builds the HTML
 * part of every platform message.
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
 *   - `brand: "locker"` (LK-07; plans/LK-00.md §7.11, §14.2) swaps the identity: the Polaris Locker
 *     lockup (`locker-horizontal-{light,dark}-640.png`, shown at 230 x 64, from the console
 *     origin's `/assets/branding/locker/`) with `alt="Polaris Locker"`, and neutral-ink actions and
 *     links instead of the violet accent (D9a: coral is identity only). Omitted = the Polaris Key
 *     output, byte for byte.
 */

import { BRAND, FONT, THEME_TOKENS } from "@polaris-key/brand";
import { escapeHtml } from "../../platform/html.js";

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
function darkCss(locker: boolean): string {
  const act = DARK.action;
  const rules = [
    `.pk-bg{background-color:${DARK.surface.page} !important}`,
    `.pk-card{background-color:${DARK.surface.raised} !important;border-color:${DARK.border.subtle} !important}`,
    `.pk-strong{color:${DARK.text.strong} !important}`,
    `.pk-text{color:${DARK.text.default} !important}`,
    `.pk-muted{color:${DARK.text.muted} !important}`,
    `.pk-key{background-color:${DARK.surface.page} !important;border-color:${DARK.border.subtle} !important}`,
    `.pk-callout{background-color:${DARK.surface.page} !important;border-color:${DARK.border.subtle} !important}`,
    `.pk-btn{background-color:${locker ? act.fill : DARK.accent.violet.solid} !important}`,
    `.pk-btn-a{color:${locker ? act.on : DARK.accent.violet.on} !important}`,
    `.pk-link{color:${locker ? DARK.text.strong : DARK.accent.violet.fg} !important}`,
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
  /**
   * A one-time code, shown first and large under the heading (SIGN-IN.md §3.4). Plain text
   * (escaped here).
   */
  code?: string;
  /** Body paragraphs, plain text (escaped here; line breaks kept). */
  paragraphs: string[];
  /** One call to action, a URL the Worker built. */
  action?: { label: string; url: string };
  /**
   * A neutral callout (D9a: ink on the page ground with a quiet border, never a status or accent
   * colour) for the one fact the reader must not miss, placed after the paragraphs. Plain text.
   */
  callout?: string;
  /** A security notice's "Wasn't you? Secure your account" line, a URL the Worker built. */
  secure?: { label: string; url: string };
  /**
   * The product as the hero (LX-27): its icon (an https image URL, optional) and name replace the
   * platform lockup above the card; the platform then shows as `secondary` instead.
   */
  hero?: { name: string; iconUrl?: string | null };
  /** A secret shown in a tinted monospace box that wraps anywhere, never at a hyphen. */
  secret?: string;
  /** Paragraphs after the `secret` box. */
  paragraphsAfter?: string[];
  /** A quiet second link with the small Polaris Key logo, under the card's content. */
  secondary?: { label: string; url: string };
  /** The small print under the card. Plain text. */
  footer: string;
  /** The origin to load the lockup from, or null to use a text wordmark instead. */
  origin: string | null;
  /** The identity: `"key"` (the default) or `"locker"` (Polaris Locker). */
  brand?: "key" | "locker";
}

/** The branded HTML part of an email. */
export function renderEmail(c: EmailContent): string {
  const locker = c.brand === "locker";
  const brandName = locker ? "Polaris Locker" : "Polaris Key";
  // Buttons and links: the platform violet for Key; neutral ink for Locker (coral is identity only).
  const btnFill = locker ? LIGHT.action.fill : LIGHT.accent.violet.solid;
  const btnOn = locker ? LIGHT.action.on : LIGHT.accent.violet.on;
  const linkFg = locker ? LIGHT.text.strong : LIGHT.accent.violet.fg;
  const font = FONT.sans.replace(/"/g, "'");
  const mono = FONT.mono.replace(/"/g, "'");
  const para = (
    text: string,
    cls = "pk-text",
    color: string = LIGHT.text.default,
  ) =>
    `<p class="${cls}" style="margin:0 0 16px;font-family:${font};font-size:16px;line-height:24px;color:${color}">${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  const lockupSrc = (variant: "light" | "dark") =>
    locker
      ? `${c.origin}/assets/branding/locker/locker-horizontal-${variant}-640.png`
      : `${c.origin}/assets/branding/key/key-horizontal-${variant}-944.png`;
  const [lw, lh] = locker ? [230, 64] : [472, 160];
  const lockup = (variant: "light" | "dark", style: string) =>
    `<img class="pk-logo-${variant}" src="${escapeHtml(lockupSrc(variant))}" width="${lw}" height="${lh}" alt="${brandName}" style="${style}">`;
  const imgStyle = `width:${lw}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none`;
  const brand = c.origin
    ? lockup("light", `display:block;margin:0 auto;${imgStyle}`) +
      // Hidden unless the dark palette applies (`mso-hide` for Outlook on Windows).
      `<!--[if !mso]><!-->${lockup("dark", `display:none;margin:0 auto;max-height:0;overflow:hidden;mso-hide:all;${imgStyle}`)}<!--<![endif]-->`
    : `<p class="pk-strong" style="margin:0;font-family:${font};font-size:20px;line-height:28px;font-weight:700;letter-spacing:-0.01em;color:${BRAND.text.light}">${brandName}</p>`;
  const action = c.action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td class="pk-btn" bgcolor="${btnFill}" style="border-radius:6px;background-color:${btnFill}"><a class="pk-btn-a" href="${escapeHtml(c.action.url)}" style="display:inline-block;padding:12px 24px;font-family:${font};font-size:16px;line-height:20px;font-weight:700;color:${btnOn};text-decoration:none;border-radius:6px">${escapeHtml(c.action.label)}</a></td></tr></table>` +
      para(
        "If the button does not work, paste this link into your browser:",
        "pk-muted",
        LIGHT.text.muted,
      ) +
      `<p style="margin:0;font-family:${mono};font-size:13px;line-height:20px;word-break:break-all"><a class="pk-link" href="${escapeHtml(c.action.url)}" style="color:${linkFg};text-decoration:underline">${escapeHtml(c.action.url)}</a></p>`
    : "";
  const secret = c.secret
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px"><tr><td class="pk-key" bgcolor="${LIGHT.surface.page}" style="padding:14px 16px;background-color:${LIGHT.surface.page};border:1px solid ${LIGHT.border.subtle};border-radius:6px;font-family:${mono};font-size:16px;line-height:24px;font-weight:700;overflow-wrap:anywhere;color:${LIGHT.text.strong}"><span class="pk-strong">${escapeHtml(c.secret).replace(/_/g, "_<wbr>")}</span></td></tr></table>`
    : "";
  const secondary = c.secondary
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr>` +
      `<td style="font-family:${font};font-size:15px;line-height:22px"><a class="pk-link" href="${escapeHtml(c.secondary.url)}" style="color:${linkFg};text-decoration:underline">${escapeHtml(c.secondary.label)}</a></td></tr></table>`
    : "";
  const hero = c.hero
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr>` +
      (c.hero.iconUrl
        ? `<td style="padding:0 14px 0 0"><img src="${escapeHtml(c.hero.iconUrl)}" width="56" height="56" alt="" style="display:block;border:0;border-radius:12px;width:56px;height:56px"></td>`
        : "") +
      `<td><h1 class="pk-strong" style="margin:0;font-family:${font};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${LIGHT.text.strong}">${escapeHtml(c.hero.name)}</h1></td></tr></table>`
    : "";
  const calloutBox = (inner: string, top: number) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${top}px 0 16px"><tr><td class="pk-callout" bgcolor="${LIGHT.surface.page}" style="padding:12px 16px;background-color:${LIGHT.surface.page};border:1px solid ${LIGHT.border.subtle};border-radius:6px;font-family:${font};font-size:15px;line-height:22px;color:${LIGHT.text.default}">${inner}</td></tr></table>`;
  const callout = c.callout
    ? calloutBox(
        `<span class="pk-text">${escapeHtml(c.callout).replace(/\n/g, "<br>")}</span>`,
        8,
      )
    : "";
  const secure = c.secure
    ? calloutBox(
        `<span class="pk-text"><strong>Wasn&#x27;t you?</strong> <a class="pk-link" href="${escapeHtml(c.secure.url)}" style="color:${linkFg};text-decoration:underline">${escapeHtml(c.secure.label)}</a></span>`,
        24,
      )
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
    `<style>:root{color-scheme:light dark;supported-color-schemes:light dark}body{margin:0;padding:0}@media (max-width:480px){.pk-key{font-size:14px!important;line-height:22px!important;padding:12px!important}}${darkCss(locker)}</style>`,
    `</head>`,
    `<body class="pk-bg" style="margin:0;padding:0;background-color:${LIGHT.surface.page}">`,
    `<table role="presentation" class="pk-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${LIGHT.surface.page}" style="width:100%;background-color:${LIGHT.surface.page}">`,
    `<tr><td align="center" style="padding:32px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px">`,
    // The lockup PNG carries its own clear space; the text wordmark needs the gap.
    // The lockup sits centred over the card (SIGN-IN.md §3.15).
    c.hero
      ? ""
      : `<tr><td align="center" style="padding:0 0 ${c.origin ? 0 : 24}px;text-align:center">${brand}</td></tr>`,
    `<tr><td class="pk-card" bgcolor="${LIGHT.surface.raised}" style="padding:32px;background-color:${LIGHT.surface.raised};border:1px solid ${LIGHT.border.subtle};border-radius:10px">`,
    c.hero
      ? hero
      : `<h1 class="pk-strong" style="margin:0 0 16px;font-family:${font};font-size:24px;line-height:32px;font-weight:700;letter-spacing:-0.01em;color:${LIGHT.text.strong}">${escapeHtml(c.heading)}</h1>`,
    c.code
      ? `<p class="pk-strong" style="margin:0 0 24px;font-family:${mono};font-size:36px;line-height:44px;font-weight:700;letter-spacing:0.12em;color:${LIGHT.text.strong}">${escapeHtml(c.code)}</p>`
      : "",
    ...c.paragraphs.map((t) => para(t)),
    secret,
    ...(c.paragraphsAfter ?? []).map((t) => para(t)),
    callout,
    action,
    secondary,
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
