import type DatabaseType from "better-sqlite3";
import { type Db, type DbParam, type DbStatement, normParam } from "./types.js";

/** better-sqlite3-backed Db for unit tests (in-memory). Synchronous under the hood. */
export class SqliteDb implements Db {
  constructor(private readonly db: DatabaseType.Database) {}

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T[]> {
    return this.db.prepare(sql).all(...params.map(normParam)) as T[];
  }

  async first<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T | null> {
    return (
      (this.db.prepare(sql).get(...params.map(normParam)) as T | undefined) ??
      null
    );
  }

  async run(sql: string, ...params: DbParam[]): Promise<void> {
    this.db.prepare(sql).run(...params.map(normParam));
  }

  async runChanges(sql: string, ...params: DbParam[]): Promise<number> {
    return this.db.prepare(sql).run(...params.map(normParam)).changes;
  }

  async batch(statements: DbStatement[]): Promise<void> {
    await this.batchChanges(statements);
  }

  async batchChanges(statements: DbStatement[]): Promise<number[]> {
    const tx = this.db.transaction((stmts: DbStatement[]) =>
      stmts.map(
        (s) => this.db.prepare(s.sql).run(...s.params.map(normParam)).changes,
      ),
    );
    return tx(statements);
  }
}
