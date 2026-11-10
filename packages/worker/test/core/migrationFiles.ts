// The migration directory and its files in order, shared by the migration replay tests.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TEST_ROOT } from "../paths.js";

export const MIGRATIONS_DIR = join(TEST_ROOT, "..", "migrations");
export const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** A database with every migration sorted before `first` applied (foreign keys off). */
export function databaseBefore(first: string): Database.Database {
  const db = new Database(":memory:");
  for (const f of MIGRATION_FILES) {
    if (f >= first) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  return db;
}

/** Applies the given migration files, in order. */
export function applyMigrations(
  db: Database.Database,
  files: readonly string[],
): void {
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
}

/** A table's column names. */
export const columnsOf = (db: Database.Database, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
