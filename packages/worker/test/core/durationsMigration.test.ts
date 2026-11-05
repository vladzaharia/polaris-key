// LX-41.1 (plans/LX-41.md §6.1): the duration columns and their vocabulary triggers, applied to a
// populated pre-migration database. Nothing reads the columns yet; this pins the schema.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT as HERE } from "../paths.js";

const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const MINE = FILES.filter((f) =>
  /^\d+_[abce]_(tiers_on_expiry|licenses_on_expiry|licenses_fallback_version|duration_vocabulary)\.sql$/.test(
    f,
  ),
);
const FIRST = MINE[0]!;
const DOWN = join(HERE, "..", "scripts", "rollback", "0154_durations.down.sql");

function populated(): Database.Database {
  const db = new Database(":memory:");
  for (const f of FILES) {
    if (f >= FIRST) break;
    db.exec(readFileSync(join(DIR, f), "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  db.exec(`
    INSERT INTO tiers (product, id, label, modified_at) VALUES ('p', 'pro', 'Pro', 1);
    INSERT INTO licenses (product, id, status, activated_at, expires_at, modified_at)
      VALUES ('p', 'lic_old', 'active', 1, 50, 1), ('p', 'lic_lapsed', 'active', 1, 100, 1);`);
  return db;
}

function migrate(db: Database.Database): void {
  for (const f of MINE) db.exec(readFileSync(join(DIR, f), "utf8"));
}

const cols = (db: Database.Database, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
    (c) => c.name,
  );

describe("duration columns migration", () => {
  it("ships exactly four files, one ADD COLUMN each", () => {
    expect(MINE).toHaveLength(4);
    const alters = MINE.map(
      (f) =>
        (readFileSync(join(DIR, f), "utf8").match(/^ALTER TABLE/gm) ?? [])
          .length,
    );
    expect(alters).toEqual([1, 1, 1, 0]);
  });

  it("adds empty columns to populated rows", () => {
    const db = populated();
    migrate(db);
    expect(cols(db, "tiers")).toContain("on_expiry");
    expect(cols(db, "licenses")).toEqual(
      expect.arrayContaining(["on_expiry", "fallback_version"]),
    );
    expect(
      db
        .prepare("SELECT on_expiry, fallback_version FROM licenses ORDER BY id")
        .all(),
    ).toEqual([
      { on_expiry: null, fallback_version: null },
      { on_expiry: null, fallback_version: null },
    ]);
    expect(db.prepare("SELECT on_expiry FROM tiers").all()).toEqual([
      { on_expiry: null },
    ]);
  });

  it("today's inserts and updates pass, and NULL passes", () => {
    const db = populated();
    migrate(db);
    db.exec(`INSERT INTO tiers (product, id, label, modified_at) VALUES ('p', 'free', 'Free', 2);
      INSERT INTO licenses (product, id, status, activated_at, modified_at) VALUES ('p', 'lic_new', 'active', 2, 2);
      UPDATE licenses SET status = 'disabled' WHERE id = 'lic_new';
      UPDATE licenses SET on_expiry = NULL WHERE id = 'lic_new';`);
  });

  it("accepts stop, keepVersion and tier:<id> up to 69 bytes", () => {
    const db = populated();
    migrate(db);
    for (const v of [
      "stop",
      "keepVersion",
      "tier:free",
      "tier:" + "a".repeat(64),
    ]) {
      db.prepare("UPDATE tiers SET on_expiry = ?").run(v);
      db.prepare("UPDATE licenses SET on_expiry = ?").run(v);
    }
    db.prepare(
      "INSERT INTO licenses (product, id, status, activated_at, on_expiry, modified_at) VALUES ('p','x','active',1,'keepVersion',1)",
    ).run();
  });

  it("refuses anything else, on insert and update, in both tables", () => {
    const db = populated();
    migrate(db);
    const bad = [
      "",
      "Stop",
      "keepversion",
      "tier:",
      "tier",
      "tier:" + "a".repeat(65),
      "tier:é" + "a".repeat(64),
      "continue",
    ];
    for (const v of bad) {
      expect(() => db.prepare("UPDATE tiers SET on_expiry = ?").run(v)).toThrow(
        /tiers\.on_expiry/,
      );
      expect(() =>
        db.prepare("UPDATE licenses SET on_expiry = ?").run(v),
      ).toThrow(/licenses\.on_expiry/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO tiers (product, id, label, on_expiry, modified_at) VALUES ('p','t2','T',?,1)",
          )
          .run(v),
      ).toThrow(/tiers\.on_expiry/);
      expect(() =>
        db
          .prepare(
            "INSERT INTO licenses (product, id, status, activated_at, on_expiry, modified_at) VALUES ('p','l2','active',1,?,1)",
          )
          .run(v),
      ).toThrow(/licenses\.on_expiry/);
    }
  });

  it("is replay-safe apart from the bare ADD COLUMNs, and indexes the due scan", () => {
    const db = populated();
    migrate(db);
    db.exec(readFileSync(join(DIR, MINE[3]!), "utf8"));
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_licenses_duration_due'",
      )
      .get() as { sql: string };
    expect(idx.sql).toMatch(
      /WHERE on_expiry IS NOT NULL AND on_expiry <> 'stop'/,
    );
  });

  it("its report-only down script changes nothing and lists both sets", () => {
    const db = populated();
    migrate(db);
    db.prepare(
      "UPDATE licenses SET on_expiry = 'keepVersion', fallback_version = '1.0' WHERE id = 'lic_lapsed'",
    ).run();
    db.prepare(
      "UPDATE licenses SET fallback_version = '1.0', expires_at = NULL WHERE id = 'lic_old'",
    ).run();
    const before = db.prepare("SELECT * FROM licenses ORDER BY id").all();
    const sql = readFileSync(DOWN, "utf8");
    const selects = sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^(\s*--.*\n)+/gm, "").trim())
      .filter((s) => /^SELECT/i.test(s));
    expect(selects).toHaveLength(2);
    expect(/\b(DROP|DELETE|UPDATE|ALTER)\b/i.test(selects.join(" "))).toBe(
      false,
    );
    for (const s of selects) db.prepare(s).all();
    expect(db.prepare(selects[1]!).all()).toEqual([
      expect.objectContaining({ id: "lic_old" }),
    ]);
    expect(db.prepare(selects[0]!).all()).toEqual([
      expect.objectContaining({ id: "lic_lapsed" }),
    ]);
    expect(db.prepare("SELECT * FROM licenses ORDER BY id").all()).toEqual(
      before,
    );
  });
});
