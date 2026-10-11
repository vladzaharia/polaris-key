import type { Db } from "../../../db/types.js";

/** A scheduled self-service erasure is reversible until this interval ends. */
export const ACCOUNT_DELETION_GRACE_SECONDS = 14 * 24 * 60 * 60;
/** Bound one cron pass; a later pass takes any remaining requests. */
export const ACCOUNT_DELETION_SWEEP_MAX = 25;

export interface AccountDeletionSchedule {
  requestedAt: number;
  dueAt: number;
}

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

export async function cancelAccountDeletion(
  db: Db,
  accountId: string,
): Promise<boolean> {
  return (
    (await db.runChanges(
      "DELETE FROM account_deletions WHERE account_id = ?",
      accountId,
    )) === 1
  );
}

/** Due account ids, oldest request first. The caller owns the irreversible erasure and notice. */
export async function dueAccountDeletions(
  db: Db,
  now: number,
): Promise<string[]> {
  const rows = await db.all<{ account_id: string }>(
    `SELECT account_id FROM account_deletions
      WHERE due_at <= ? ORDER BY due_at, account_id LIMIT ?`,
    now,
    ACCOUNT_DELETION_SWEEP_MAX,
  );
  return rows.map((row) => row.account_id);
}
