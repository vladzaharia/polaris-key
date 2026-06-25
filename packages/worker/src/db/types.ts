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
  /** Atomic batch (D1 batch / SQLite transaction). */
  batch(statements: DbStatement[]): Promise<void>;
}

/** Normalize a bound param to what both D1 and better-sqlite3 accept (no undefined/boolean). */
export function normParam(p: DbParam): string | number | null | ArrayBuffer {
  if (p === undefined || p === null) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
}
