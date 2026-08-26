// A tiny database abstraction over the subset of D1 the repository layer needs, so repos
// can be unit-tested against in-memory SQLite (better-sqlite3) without miniflare, then run
// unchanged against real D1 in production.

export type DbParam =
  | string
  | number
  | boolean
  | null
  | undefined
  | ArrayBuffer;

export interface DbStatement {
  sql: string;
  params: DbParam[];
}

export interface Db {
  all<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T[]>;
  first<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T | null>;
  run(sql: string, ...params: DbParam[]): Promise<void>;
  /**
   * `run`, but returns the number of rows the statement actually changed.
   *
   * This is the primitive that makes a conditional write ATOMIC without a transaction: issue
   * `UPDATE ... WHERE <precondition>` and treat `changes === 0` as "someone else got there
   * first". Both engines report it natively (D1 `meta.changes`, better-sqlite3 `info.changes`),
   * so a single statement replaces a check-then-act pair with an `await` in the middle — see
   * `markPortalDownloadUsed` (R9-05b) and `claimDeviceSeat` (R11-02).
   */
  runChanges(sql: string, ...params: DbParam[]): Promise<number>;
  /** Atomic batch (D1 batch / SQLite transaction). */
  batch(statements: DbStatement[]): Promise<void>;
}

/** Normalize a bound param to what both D1 and better-sqlite3 accept (no undefined/boolean). */
export function normParam(p: DbParam): string | number | null | ArrayBuffer {
  if (p === undefined || p === null) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
}
