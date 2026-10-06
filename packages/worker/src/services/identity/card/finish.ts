/**
 * The one way a login-card sign-in ends (I-07): the account's licence links are refreshed, the
 * sign-in is audited, an account session opens (`portal/accountSessions.ts`), and the answer says
 * whether to show the "add another way to sign in" card (PORTAL.md §4.10).
 *
 * LX-26: the refresh is the link sweep, whose email half is Core's `onAccountEmailVerified` body
 * run for every address the account verified, the one just proved included. So a code, register,
 * gate or provider sign-in brings the licences waiting on its address (S-24 §5.4).
 */

import type { Db, Env } from "../../../core/platform.js";
import { startAccountSession } from "../portal/accountSessions.js";
import { portalAudit, syncAccountLicenseLinks } from "../portal/repo.js";

/** The nudge comes back after this long if the account still has a single sign-in method. */
export const NUDGE_REPEAT_SECONDS = 30 * 86_400;

export interface FinishedSignIn {
  /** The account session's `Set-Cookie`. */
  cookie: string;
  /** Show the "add another way to sign in" card now. */
  nudge: boolean;
}

export async function finishSignIn(
  env: Env,
  db: Db,
  req: Request,
  account: {
    id: string;
    display_name: string | null;
    primary_email: string | null;
  },
  input: { amr: readonly string[]; action: string; summary: string },
  now: number,
): Promise<FinishedSignIn> {
  await syncAccountLicenseLinks(db, account.id, now);
  await portalAudit(db, {
    accountId: account.id,
    action: input.action,
    summary: input.summary,
    now,
  });
  const started = await startAccountSession(
    env,
    db,
    { account, req, amr: input.amr },
    now,
  );
  // Shown once when due: the answer carries it, and the next sign-in does not repeat it.
  const nudge = await nudgeDue(db, account.id, now);
  if (nudge) await markNudgeShown(db, account.id, now);
  return { cookie: started.cookie, nudge };
}

/**
 * Whether the "add another way to sign in" card is due: never shown yet, or shown at least 30
 * days ago while the account still has a single sign-in method (PORTAL.md §4.10).
 */
export async function nudgeDue(
  db: Db,
  accountId: string,
  now: number,
): Promise<boolean> {
  const row = await db.first<{
    nudge_shown_at: number | null;
    methods: number;
  }>(
    `SELECT a.nudge_shown_at AS nudge_shown_at,
            (SELECT COUNT(*) FROM account_links l WHERE l.account_id = a.id) AS methods
       FROM accounts a WHERE a.id = ?`,
    accountId,
  );
  if (!row) return false;
  if (row.nudge_shown_at === null) return true;
  return row.methods <= 1 && now - row.nudge_shown_at >= NUDGE_REPEAT_SECONDS;
}

/** Record that the card was shown (or dismissed) now. */
export async function markNudgeShown(
  db: Db,
  accountId: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE accounts SET nudge_shown_at = ? WHERE id = ?",
    now,
    accountId,
  );
}
