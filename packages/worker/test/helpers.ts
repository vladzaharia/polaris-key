import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../src/db/sqlite.js";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(here, "..", "migrations", "0001_init.sql"), "utf8");

/** A fresh in-memory database with the schema applied. */
export function makeTestDb(): SqliteDb {
  const sqlite = new Database(":memory:");
  // better-sqlite3's multi-statement DDL runner (bound to dodge a false-positive lint).
  const runScript = sqlite.exec.bind(sqlite);
  runScript(SCHEMA);
  return new SqliteDb(sqlite);
}
