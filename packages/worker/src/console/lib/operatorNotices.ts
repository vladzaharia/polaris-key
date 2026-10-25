/**
 * Operator notices to every active Superadmin (ST-31.7 G5, ST-30c.1). Shared by the access
 * handlers (invitations sent) and the break-glass sign-in, so neither imports the other.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import type { NoticeMessage } from "../../core/notify/templates.js";
import { consoleDirectory } from "../../services/identity/public.js";
import {
  sendOperatorNotice,
  superadminAccountIds,
} from "../handlers/accessShared.js";

/** The most addresses one change mails. */
export const NOTICE_CAP = 25;

/** One notice to every active Superadmin that has an address (G5), within `mails`. */
export async function notifySuperadmins(
  env: Env,
  db: Db,
  now: number,
  message: NoticeMessage,
  mails: { left: number },
  priority = false,
): Promise<{ sent: number; of: number }> {
  try {
    const ids = (await superadminAccountIds(env, db, now)).map((s) => s.id);
    const dir = await consoleDirectory(env, db, ids, now);
    const seen = new Set<string>();
    const to: string[] = [];
    for (const id of ids) {
      const e = dir.get(id);
      const addr = e?.email.trim();
      if (!e || e.disabled || !addr || seen.has(addr.toLowerCase())) continue;
      seen.add(addr.toLowerCase());
      to.push(addr);
    }
    const recipients = to.slice(
      0,
      Math.max(0, Math.min(NOTICE_CAP, mails.left)),
    );
    mails.left -= recipients.length;
    const ok = await Promise.all(
      recipients.map((a) =>
        sendOperatorNotice(env, db, a, message, now, priority),
      ),
    );
    return { sent: ok.filter(Boolean).length, of: recipients.length };
  } catch {
    return { sent: 0, of: 0 };
  }
}
