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
    .replace(/"/g, "&quot;");
}

export async function sendMagicLink(
  env: Env,
  to: string,
  link: string,
): Promise<boolean> {
  const email = env.EMAIL;
  if (!email) return false;
  await email.send({
    from: fromAddress(env),
    to,
    subject: "Sign in to Polaris Key",
    text: `Use this link to sign in to Polaris Key:\n\n${link}\n\nThis link expires in 10 minutes.`,
    html: `<p>Use this link to sign in to Polaris Key:</p><p><a href="${escapeHtml(link)}">Sign in</a></p><p>This link expires in 10 minutes.</p>`,
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
    html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`,
  });
}
