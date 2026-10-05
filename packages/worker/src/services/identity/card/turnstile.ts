/**
 * Cloudflare Turnstile on the login card (I-07; S-16 §5.4 item 4, "Turnstile on the card").
 *
 * The card asks for a Turnstile token only where it SENDS mail (the email start): that is the
 * abuse vector (a sender's reputation and a stranger's inbox), and the per-IP, per-network and
 * per-recipient limits of I-02 sit behind it. A token is verified once against Cloudflare's
 * `siteverify` endpoint with the deploy's secret key and the client's address; any failure,
 * including an unreachable endpoint, refuses (fail closed).
 *
 * With no `TURNSTILE_SECRET_KEY` configured the card asks for no token (local development and
 * the test suites); production and staging set it (RUNBOOK "Login card", a human input).
 */

import type { Env } from "../../../core/platform.js";
import { clientIp } from "../../../core/rateLimit.js";

export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The longest token Cloudflare documents (2048 characters). */
const TOKEN_MAX = 2048;

/** Whether the deploy has Turnstile turned on. */
export function turnstileEnabled(env: Env): boolean {
  return (
    typeof env.TURNSTILE_SECRET_KEY === "string" &&
    env.TURNSTILE_SECRET_KEY !== ""
  );
}

/** The public site key the card renders the widget with, or null when Turnstile is off. */
export function turnstileSiteKey(env: Env): string | null {
  return turnstileEnabled(env) &&
    typeof env.TURNSTILE_SITE_KEY === "string" &&
    env.TURNSTILE_SITE_KEY !== ""
    ? env.TURNSTILE_SITE_KEY
    : null;
}

/**
 * Whether `token` passes. True without a check when Turnstile is off; otherwise only a
 * `success: true` from `siteverify` passes.
 */
export async function verifyTurnstile(
  env: Env,
  req: Request,
  token: unknown,
): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  if (typeof token !== "string" || token === "" || token.length > TOKEN_MAX)
    return false;
  const form = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY as string,
    response: token,
  });
  const ip = clientIp(req);
  if (ip !== "unknown") form.set("remoteip", ip);
  try {
    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const out = (await res.json()) as { success?: unknown };
    return out.success === true;
  } catch {
    return false;
  }
}
