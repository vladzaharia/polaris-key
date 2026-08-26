/// <reference types="@cloudflare/workers-types" />
import { type Db, type DbParam, type DbStatement, normParam } from "./types.js";

/**
 * A D1 statement that reported failure instead of throwing.
 *
 * R11-11: `D1Result.success === false` used to be discarded, so a failed read degraded to an
 * empty result set — indistinguishable from "no rows". Because `countActiveDevices` and friends
 * default a missing count to `0`, that made a swallowed D1 error read as **seat count 0**, i.e.
 * fail-OPEN on the device limit. Every result is now inspected and a failure is raised.
 */
export class D1QueryError extends Error {
  constructor(
    readonly sql: string,
    cause?: string,
  ) {
    super(`D1 query failed: ${cause ?? "unknown error"}`);
    this.name = "D1QueryError";
  }
}

/**
 * Throw unless D1 reports the statement succeeded.
 *
 * `@cloudflare/workers-types` declares `success` as the literal `true`, so TypeScript believes
 * a failure is unrepresentable. That type is precisely the assumption R11-11 is about — the
 * runtime does return `success: false` with an `error` string — so the check is made against a
 * widened view of the result rather than deleted to satisfy the declaration.
 */
function assertOk<T>(r: D1Result<T>, sql: string): D1Result<T> {
  const reported = r as unknown as { success?: boolean; error?: string };
  if (reported.success === false) throw new D1QueryError(sql, reported.error);
  return r;
}

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
    const r = assertOk(await this.stmt(sql, params).all<T>(), sql);
    return r.results ?? [];
  }

  async first<T = Record<string, unknown>>(
    sql: string,
    ...params: DbParam[]
  ): Promise<T | null> {
    return (await this.stmt(sql, params).first<T>()) ?? null;
  }

  async run(sql: string, ...params: DbParam[]): Promise<void> {
    assertOk(await this.stmt(sql, params).run(), sql);
  }

  async runChanges(sql: string, ...params: DbParam[]): Promise<number> {
    const r = assertOk(await this.stmt(sql, params).run(), sql);
    return r.meta?.changes ?? 0;
  }

  async batch(statements: DbStatement[]): Promise<void> {
    const results = await this.d1.batch(
      statements.map((s) => this.stmt(s.sql, s.params)),
    );
    results.forEach((r, i) => assertOk(r, statements[i]?.sql ?? "batch"));
  }
}
