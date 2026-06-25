/// <reference types="@cloudflare/workers-types" />
import { type Db, type DbParam, type DbStatement, normParam } from "./types.js";

/** D1-backed Db used in production (workerd). */
export class D1Db implements Db {
  constructor(private readonly d1: D1Database) {}

  private stmt(sql: string, params: DbParam[]): D1PreparedStatement {
    return this.d1.prepare(sql).bind(...params.map(normParam));
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T[]> {
    const r = await this.stmt(sql, params).all<T>();
    return r.results ?? [];
  }

  async first<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T | null> {
    return (await this.stmt(sql, params).first<T>()) ?? null;
  }

  async run(sql: string, ...params: DbParam[]): Promise<void> {
    await this.stmt(sql, params).run();
  }

  async batch(statements: DbStatement[]): Promise<void> {
    await this.d1.batch(statements.map((s) => this.stmt(s.sql, s.params)));
  }
}
