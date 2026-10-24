import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import {
  loadTemplate,
  makeTestDb,
  migrateFresh,
  templateKey,
} from "./helpers.js";

const SQL = [
  "CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);",
  "CREATE INDEX a_v ON a (v); PRAGMA user_version = 3;",
];

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pkey-helpers-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("makeTestDb template", () => {
  it("a clone matches a fresh migrate: schema, user_version, pragmas", async () => {
    const fresh = migrateFresh(readAllMigrations());
    const clone = makeTestDb();
    const master = (db: Database.Database) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
        )
        .all();
    const cloneRows = await clone.all(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    );
    expect(cloneRows).toEqual(master(fresh));
    expect(cloneRows.length).toBeGreaterThan(50);
    for (const pragma of ["user_version", "foreign_keys", "journal_mode"]) {
      const a = (await clone.first(`PRAGMA ${pragma}`)) as Record<
        string,
        unknown
      >;
      expect(a, pragma).toEqual(fresh.prepare(`PRAGMA ${pragma}`).get());
    }
    fresh.close();
  });

  it("two clones are independent", async () => {
    const a = makeTestDb();
    const b = makeTestDb();
    await a.run("CREATE TABLE only_in_a (x INTEGER)");
    expect(
      await b.first("SELECT name FROM sqlite_master WHERE name = 'only_in_a'"),
    ).toBeNull();
  });

  it("rebuilds a corrupt cache file", () => {
    const dir = scratch();
    loadTemplate(SQL, dir);
    const file = join(dir, `${templateKey(SQL)}.sqlite`);
    writeFileSync(file, Buffer.from("this is not a database, not even close"));
    const bytes = loadTemplate(SQL, dir);
    const db = new SqliteDb(new Database(bytes));
    return db.first("PRAGMA user_version").then((r) => {
      expect(r).toEqual({ user_version: 3 });
      // the file on disk is healed too
      expect(
        new Database(loadTemplate(SQL, dir)).pragma("user_version", {
          simple: true,
        }),
      ).toBe(3);
      expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("the cache key changes when a migration's bytes change", () => {
    expect(templateKey(SQL)).toBe(templateKey([...SQL]));
    expect(templateKey([SQL[0]!, SQL[1]! + " "])).not.toBe(templateKey(SQL));
    expect(templateKey([SQL[0]! + SQL[1]!])).not.toBe(templateKey(SQL));
    expect(templateKey(SQL)).toMatch(/^[0-9a-f]{64}$/);
  });
});

function readAllMigrations(): string[] {
  // Same source as helpers.ts: the migrations directory, filename order.
  const dir = new URL("../migrations/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSyncUtf8(new URL(f, dir)));
}
import { readFileSync } from "node:fs";
function readFileSyncUtf8(u: URL): string {
  return readFileSync(u, "utf8");
}
