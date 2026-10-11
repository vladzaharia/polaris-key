import type { Db } from "../../../db/types.js";
import { deleteAccount, ERASURE_LEASE_SECONDS } from "./deletion.js";
import type { AccountContext } from "./links.js";

/** A scheduled self-service erasure is reversible until this interval ends. */
export const ACCOUNT_DELETION_GRACE_SECONDS = 14 * 24 * 60 * 60;
/** A scheduled claim uses the hard erasure's own lease, so retries cannot overlap its transition. */
export const ACCOUNT_DELETION_CLAIM_SECONDS = ERASURE_LEASE_SECONDS;
/** Bound one cron pass; a later pass takes any remaining requests. */
export const ACCOUNT_DELETION_SWEEP_MAX = 25;

export interface AccountDeletionSchedule {
  requestedAt: number;
  dueAt: number;
}

export type AccountDeletionCancellation =
  | "cancelled"
  | "missing"
  | "in_progress";

export async function accountDeletionSchedule(
  db: Db,
  accountId: string,
): Promise<AccountDeletionSchedule | null> {
  const row = await db.first<{ requested_at: number; due_at: number }>(
    "SELECT requested_at, due_at FROM account_deletions WHERE account_id = ?",
    accountId,
  );
  return row
    ? { requestedAt: row.requested_at, dueAt: row.due_at }
    : null;
}

/** Schedule once. Repeating the request preserves the original deadline. */
export async function scheduleAccountDeletion(
  db: Db,
  accountId: string,
  now: number,
): Promise<{ schedule: AccountDeletionSchedule; created: boolean }> {
  const dueAt = now + ACCOUNT_DELETION_GRACE_SECONDS;
  const changes = await db.runChanges(
    `INSERT OR IGNORE INTO account_deletions (account_id, requested_at, due_at)
     VALUES (?, ?, ?)`,
    accountId,
    now,
    dueAt,
  );
  const schedule = await accountDeletionSchedule(db, accountId);
  if (!schedule) throw new Error("account deletion schedule disappeared");
  return { schedule, created: changes === 1 };
}

/**
 * Cancel only before the deadline and before cron has claimed it. A missing request is idempotent;
 * a due request is irreversible even if the next cron has not started its hard erasure yet.
 */
export async function cancelAccountDeletion(
  db: Db,
  accountId: string,
  now: number,
): Promise<AccountDeletionCancellation> {
  const cancelled = await db.runChanges(
    `DELETE FROM account_deletions
      WHERE account_id = ? AND due_at > ?
        AND (claimed_until IS NULL OR claimed_until <= ?)`,
    accountId,
    now,
    now,
  );
  if (cancelled === 1) return "cancelled";
  return (await accountDeletionSchedule(db, accountId))
    ? "in_progress"
    : "missing";
}

/** Due account ids whose lease is free, oldest request first. */
export async function dueAccountDeletions(
  db: Db,
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ account_id: string }>(
    `SELECT account_id FROM account_deletions
      WHERE due_at <= ? AND (claimed_until IS NULL OR claimed_until <= ?)
      ORDER BY due_at, account_id LIMIT ?`,
    now,
    now,
    ACCOUNT_DELETION_SWEEP_MAX,
  );
  return rows.map((row) => row.account_id);
}

/**
 * Claim a due request before starting the existing hard-erasure state machine. The conditional
 * update makes cancellation and the scheduler race safely: exactly one can win.
 */
export async function claimDueAccountDeletion(
  db: Db,
  accountId: string,
  now: number,
): Promise<boolean> {
  return (
    (await db.runChanges(
      `UPDATE account_deletions SET claimed_until = ?
        WHERE account_id = ? AND due_at <= ?
          AND (claimed_until IS NULL OR claimed_until <= ?)`,
      now + ACCOUNT_DELETION_CLAIM_SECONDS,
      accountId,
      now,
      now,
    )) === 1
  );
}

/**
 * Move due requests into the resumable hard-erasure state machine. A claim is retained until the
 * erasure's final batch removes it, while a failed pre-transition can be reclaimed after its lease.
 */
export async function sweepAccountDeletions(
  ctx: AccountContext,
): Promise<{ attempted: number; started: number }> {
  const due = await dueAccountDeletions(ctx.db, ctx.now);
  let attempted = 0;
  let started = 0;
  for (const accountId of due) {
    if (!(await claimDueAccountDeletion(ctx.db, accountId, ctx.now))) continue;
    attempted++;
    if ((await deleteAccount(ctx, accountId)).ok) started++;
  }
  return { attempted, started };
}
