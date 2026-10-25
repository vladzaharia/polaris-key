// Migration 0131_a (LX-27c.1) replayed on a populated licenses table: the column arrives empty on
// every existing row, takes an epoch-seconds value, and its down script removes it again.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT as HERE } from "../../paths.js";

const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TARGET = FILES.find((f) => f.endsWith("_license_invited_at.sql"))!;
const DOWN = join(
  HERE,
  "..",
  "scripts",
  "rollback",
  TARGET.replace(/\.sql$/, ".down.sql"),
);

function populated(): Database.Database {
  const db = new Database(":memory:");
  for (const f of FILES) {
    if (f >= TARGET) break;
    db.exec(readFileSync(join(DIR, f), "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  db.prepare(
    `INSERT INTO licenses (product, id, status, activated_at, origin, modified_at)
     VALUES ('p', 'lic_old', 'active', 1, 'admin', 1)`,
  ).run();
  return db;
}

const columns = (db: Database.Database): string[] =>
  (db.prepare("PRAGMA table_info(licenses)").all() as { name: string }[]).map(
    (c) => c.name,
  );

describe("license invited_at migration", () => {
  it("adds a nullable column that is empty on every existing row", () => {
    const db = populated();
    expect(columns(db)).not.toContain("invited_at");
    db.exec(readFileSync(join(DIR, TARGET), "utf8"));
    expect(columns(db)).toContain("invited_at");
    expect(
      db
        .prepare("SELECT invited_at AS at FROM licenses WHERE id = 'lic_old'")
        .get(),
    ).toEqual({ at: null });
    db.prepare("UPDATE licenses SET invited_at = ? WHERE id = 'lic_old'").run(
      1_700_000_000,
    );
    expect(
      db
        .prepare("SELECT invited_at AS at FROM licenses WHERE id = 'lic_old'")
        .get(),
    ).toEqual({ at: 1_700_000_000 });
  });

  it("its down script drops the column and keeps the rows", () => {
    const db = populated();
    db.exec(readFileSync(join(DIR, TARGET), "utf8"));
    db.exec(readFileSync(DOWN, "utf8"));
    expect(columns(db)).not.toContain("invited_at");
    expect(db.prepare("SELECT id FROM licenses").all()).toEqual([
      { id: "lic_old" },
    ]);
  });
});
