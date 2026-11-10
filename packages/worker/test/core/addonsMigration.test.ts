// LX-35.1: the add-ons table, the nullable grants.addon_id with its index, the backfill ledger and
// the index assertion that now names the index, applied to a populated pre-migration database.
// Nothing reads them yet; this pins the schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as files from "./migrationFiles.js";
import { TEST_ROOT as HERE } from "../paths.js";

const { MIGRATIONS_DIR, MIGRATION_FILES } = files;
const MINE = MIGRATION_FILES.filter(
  (f) =>
    /^\d+_[abc]_(addons|grants_addon_id|index_assertion)\.sql$/.test(f) &&
    f.startsWith("0161"),
);
const DOWN = join(HERE, "..", "scripts", "rollback", "0161_addons.down.sql");

function populated() {
  const db = files.databaseBefore(MINE[0]!);
  db.exec(`INSERT INTO grants (product, id, license_id, source, state, granted_at, created_by, modified_at, modified_by)
      VALUES ('p', 'g1', 'l1', 'comp', 'active', 1, 'x', 1, 'x')`);
  return db;
}
const migrate = (db: ReturnType<typeof populated>) =>
  files.applyMigrations(db, MINE);
const indexes = (db: ReturnType<typeof populated>): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[]
  ).map((i) => i.name);

describe("add-ons migration", () => {
  it("ships the table, the column and the assertion, in order", () => {
    expect(MINE.map((f) => f.slice(5))).toEqual([
      "a_addons.sql",
      "b_grants_addon_id.sql",
      "c_index_assertion.sql",
    ]);
  });

  it("leaves existing grants with no add-on and indexes only those that have one", () => {
    const db = populated();
    migrate(db);
    expect(db.prepare("SELECT id, addon_id FROM grants").all()).toEqual([
      { id: "g1", addon_id: null },
    ]);
    expect(indexes(db)).toContain("idx_grants_addon");
    db.prepare("UPDATE grants SET addon_id = 'adn_1'").run();
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM grants WHERE product = 'p' AND addon_id = 'adn_1'",
      )
      .all() as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toContain("idx_grants_addon");
  });

  it("creates add-ons with an empty template and a positive unit count", () => {
    const db = populated();
    migrate(db);
    db.prepare(
      "INSERT INTO addons (product, id, label, modified_at) VALUES ('p', 'adn_seat', 'Seat', 1)",
    ).run();
    expect(
      db.prepare("SELECT entitlements_json, units, source FROM addons").all(),
    ).toEqual([{ entitlements_json: "{}", units: null, source: "manifest" }]);
    const bad = (cols: string, vals: string) => () =>
      db
        .prepare(
          `INSERT INTO addons (product, id, label, modified_at, ${cols}) VALUES ('p', 'x', 'X', 1, ${vals})`,
        )
        .run();
    expect(bad("units", "0")).toThrow(/CHECK/);
    expect(bad("source", "'other'")).toThrow(/CHECK/);
    db.prepare("UPDATE addons SET units = 5").run();
  });

  it("creates the ledger keyed by subject and field", () => {
    const db = populated();
    migrate(db);
    const ins = db.prepare(
      "INSERT INTO addon_backfill (product, subject_kind, subject_id, field, run_id, at) VALUES ('p', ?, 'a', 'addon_id', 'r', 1)",
    );
    ins.run("grant");
    ins.run("addon");
    expect(() => ins.run("grant")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run("device")).toThrow(/CHECK/);
  });

  it("the assertion passes with the index and aborts without it", () => {
    const db = populated();
    migrate(db);
    expect(
      db
        .prepare("SELECT expected = found AS ok FROM schema_index_assertion")
        .get(),
    ).toEqual({ ok: 1 });
    db.exec("DROP INDEX idx_grants_addon");
    expect(() =>
      db.exec(readFileSync(join(MIGRATIONS_DIR, MINE[2]!), "utf8")),
    ).toThrow(/required_indexes_are_missing/);
  });

  it("the rollback drops the tables, the index and the column and keeps the grants", () => {
    const db = populated();
    migrate(db);
    db.exec(readFileSync(DOWN, "utf8"));
    expect(indexes(db)).not.toContain("idx_grants_addon");
    expect(files.columnsOf(db, "grants")).not.toContain("addon_id");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).not.toContain("addons");
    expect(tables).not.toContain("addon_backfill");
    expect(db.prepare("SELECT id FROM grants").all()).toEqual([{ id: "g1" }]);
  });
});
