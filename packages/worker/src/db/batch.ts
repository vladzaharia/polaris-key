import type { Db, DbStatement } from "./types.js";

/**
 * Run a batch and answer each statement's changed-row count, in order: atomic on D1 and SQLite
 * (`batchChanges`), one after another on a test double that has none. A conditional first
 * statement then tells the caller whether the whole guarded batch applied.
 */
export async function batchCounts(
  db: Db,
  statements: DbStatement[],
): Promise<number[]> {
  if (db.batchChanges) return db.batchChanges(statements);
  const out: number[] = [];
  for (const s of statements) out.push(await db.runChanges(s.sql, ...s.params));
  return out;
}
