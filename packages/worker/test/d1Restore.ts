import type { Db, DbParam } from "../src/db/types.js";

/** Every row of every table, as `SELECT *` returned them: the state a D1 Time Travel bookmark names. */
export type DbSnapshot = Array<{
  table: string;
  rows: Array<Record<string, unknown>>;
}>;

/** Copy the whole database (every table, every row). */
export async function snapshotDb(db: Db): Promise<DbSnapshot> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const snapshot: DbSnapshot = [];
  for (const { name } of tables)
    snapshot.push({
      table: name,
      rows: await db.all(`SELECT * FROM "${name}"`),
    });
  return snapshot;
}

/**
 * Rewind the database IN PLACE to `snapshot`, as `wrangler d1 time-travel restore` does: every
 * table is emptied and refilled, so rows written since (an erasure tombstone, the erased
 * account's absence) vanish together and the rows deleted since come back. Nothing outside the
 * database is touched: an R2 bucket, KV and Durable Objects keep what they hold.
 */
export async function restoreDb(db: Db, snapshot: DbSnapshot): Promise<void> {
  const fk = await db.first<{ foreign_keys: number }>("PRAGMA foreign_keys");
  await db.run("PRAGMA foreign_keys = OFF");
  try {
    for (const { table, rows } of snapshot) {
      await db.run(`DELETE FROM "${table}"`);
      for (const row of rows) {
        const columns = Object.keys(row);
        await db.run(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
           VALUES (${columns.map(() => "?").join(", ")})`,
          ...columns.map((c) => row[c] as DbParam),
        );
      }
    }
  } finally {
    if (fk?.foreign_keys === 1) await db.run("PRAGMA foreign_keys = ON");
  }
}
