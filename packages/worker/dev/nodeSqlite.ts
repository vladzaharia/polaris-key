/**
 * `Db` over Node's built-in SQLite (`node:sqlite`, Node >= 22.13): what `pkey dev` runs the real
 * Worker router on, with no native addon and no Cloudflare account. Same contract as `d1.ts`
 * (an atomic batch, per-statement change counts) and `sqlite.ts` (the better-sqlite3 test twin).
 */
import {
  type Db,
  type DbParam,
  type DbStatement,
  normParam,
} from "../src/db/types.js";

/** The slice of `node:sqlite`'s `DatabaseSync` this file uses. */
export interface SqliteHandle {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
  };
}

/** Open an in-memory database; the one `ExperimentalWarning` Node 22 prints is not repeated. */
export async function openMemoryDb(): Promise<SqliteHandle> {
  const emit = process.emitWarning;
  process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
    const text = typeof w === "string" ? w : ((w as Error)?.message ?? "");
    if (/SQLite/i.test(text)) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteHandle;
    };
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  } finally {
    process.emitWarning = emit;
  }
}

const bind = (params: DbParam[]): unknown[] =>
  params.map((p) => {
    const v = normParam(p);
    return v instanceof ArrayBuffer ? new Uint8Array(v) : v;
  });

export class NodeSqliteDb implements Db {
  constructor(private readonly db: SqliteHandle) {}

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...bind(params)) as T[];
  }

  async first<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T | null> {
    return (this.db.prepare(sql).get(...bind(params)) as T | undefined) ?? null;
  }

  async run(sql: string, ...params: DbParam[]): Promise<void> {
    this.db.prepare(sql).run(...bind(params));
  }

  async runChanges(sql: string, ...params: DbParam[]): Promise<number> {
    return Number(this.db.prepare(sql).run(...bind(params)).changes);
  }

  async batch(statements: DbStatement[]): Promise<void> {
    await this.batchChanges(statements);
  }

  async batchChanges(statements: DbStatement[]): Promise<number[]> {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) =>
        Number(this.db.prepare(s.sql).run(...bind(s.params)).changes),
      );
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
