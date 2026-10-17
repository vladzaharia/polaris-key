/**
 * Where a platform notice can go, and what happens when email cannot carry it.
 *
 * Email is the one destination today. When the deploy has no mail binding (or the recipient is
 * suppressed or unreachable), a flow that hands someone a link (an invitation, a licence key's
 * download) degrades to showing that link for the sender to copy, rather than failing: see
 * `deliverOrLink`. Further destinations (ST-27's alert webhooks) are added here, not beside it.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { deliverEmail } from "./emailDelivery.js";
import type { NoticeMessage } from "./templates.js";

/** Can this deploy send platform mail at all? */
export function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL);
}

/** The outcome of {@link deliverOrLink}: mailed, or a link to copy. */
export type LinkDelivery =
  | { delivered: true }
  | { delivered: false; link: string };

/**
 * Mail `message` to `to`; when it cannot go out (no binding, no address, a suppressed or
 * unreachable recipient, a provider error) answer the `link` instead, for the caller to show as
 * copyable. Nothing here throws on a provider error.
 */
export async function deliverOrLink(
  env: Env,
  db: Db,
  to: string | null | undefined,
  message: NoticeMessage,
  link: string,
  now: number,
): Promise<LinkDelivery> {
  if (!to || !emailConfigured(env)) return { delivered: false, link };
  try {
    const result = await deliverEmail(
      env,
      db,
      { sender: { kind: "platform" }, to, ...message },
      now,
    );
    return result.ok ? { delivered: true } : { delivered: false, link };
  } catch {
    return { delivered: false, link };
  }
}
