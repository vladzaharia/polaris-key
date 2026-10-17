/**
 * P0-26's golden harness, the recording half: a `Db` wrapper that notes every write (batched or
 * not) as `{ table, sql, params }`, counts D1 round trips, and masks what is random per run
 * (ids, sealed envelopes, minted keys). Reads pass through and count as a trip each, a batch as
 * one.
 */
import type { Db, DbParam, DbStatement } from "../../src/db/types.js";

export interface Write {
  table: string;
  sql: string;
  params: unknown[];
}

const WRITE_RE =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM|REPLACE\s+INTO)\s+"?(\w+)"?/i;

/** The table a write statement targets, or null for a read. */
export function writeTable(sql: string): string | null {
  const m = WRITE_RE.exec(sql);
  return m ? m[1]!.toLowerCase() : null;
}

const collapse = (sql: string): string => sql.replace(/\s+/g, " ").trim();

/** Mask what differs between two runs of the same scenario. */
export function mask(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof ArrayBuffer) return "<bytes>";
  if (typeof v !== "string") return v;
  let s = v;
  s = s.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<uuid>",
  );
  s = s.replace(/\bpkey[a-z]*_[A-Za-z0-9_-]{16,}/g, "<token>");
  s = s.replace(/\b(aud|cit)_[A-Za-z0-9_-]{12}/g, "$1_<id>");
  s = s.replace(
    /(\b(?:iv|ct|tag|wrapped)\\*"\s*:\s*\\*")[^"\\]+/g,
    "$1<sealed>",
  );
  s = s.replace(/[A-Za-z0-9_-]{43,}/g, "<blob>");
  return s;
}

/** Columns that hold a per-run random value (a token hash, a token id). */
const RANDOM_COLUMNS = new Set(["token_hash", "token_id", "jti"]);

export class RecordingDb implements Db {
  readonly writes: Write[] = [];
  trips = 0;
  constructor(private readonly inner: Db) {}

  private note(sql: string, params: readonly DbParam[]): void {
    const table = writeTable(sql);
    if (table)
      this.writes.push({
        table,
        sql: collapse(sql),
        params: params.map(mask),
      });
  }

  all<T = Record<string, unknown>>(sql: string, ...p: DbParam[]): Promise<T[]> {
    this.trips++;
    return this.inner.all<T>(sql, ...p);
  }
  first<T = Record<string, unknown>>(
    sql: string,
    ...p: DbParam[]
  ): Promise<T | null> {
    this.trips++;
    return this.inner.first<T>(sql, ...p);
  }
  run(sql: string, ...p: DbParam[]): Promise<void> {
    this.trips++;
    this.note(sql, p);
    return this.inner.run(sql, ...p);
  }
  runChanges(sql: string, ...p: DbParam[]): Promise<number> {
    this.trips++;
    this.note(sql, p);
    return this.inner.runChanges(sql, ...p);
  }
  batch(statements: DbStatement[]): Promise<void> {
    this.trips++;
    for (const s of statements) this.note(s.sql, s.params);
    return this.inner.batch(statements);
  }
  batchChanges(statements: DbStatement[]): Promise<number[]> {
    this.trips++;
    for (const s of statements) this.note(s.sql, s.params);
    return this.inner.batchChanges!(statements);
  }

  /** Each table's writes in order; audit rows compared as a sorted multiset. */
  byTable(): Record<string, Write[] | string[]> {
    const out: Record<string, Write[]> = {};
    for (const w of this.writes) (out[w.table] ??= []).push(w);
    const sorted: Record<string, Write[] | string[]> = {};
    for (const t of Object.keys(out).sort()) {
      sorted[t] =
        t === "audit" ? out[t]!.map((w) => JSON.stringify(w)).sort() : out[t]!;
    }
    return sorted;
  }

  /** A dump of every table written, masked, in rowid order. */
  async dump(): Promise<Record<string, unknown[]>> {
    const tables = [...new Set(this.writes.map((w) => w.table))].sort();
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      const rows = await this.inner.all<Record<string, unknown>>(
        `SELECT * FROM ${t} ORDER BY rowid`,
      );
      out[t] = rows.map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            RANDOM_COLUMNS.has(k) ? "<random>" : mask(v),
          ]),
        ),
      );
    }
    return out;
  }
}
