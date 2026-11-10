// LX-34.2: the tier entitlements column, the entitlement catalog table and the bucket job's ledger,
// applied to a populated pre-migration database. Nothing reads them yet; this pins the schema.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import * as files from "./migrationFiles.js";
import { TEST_ROOT as HERE } from "../paths.js";

const { MIGRATIONS_DIR, MIGRATION_FILES } = files;
const { applyMigrations, columnsOf, databaseBefore } = files;

const MINE = MIGRATION_FILES.filter((f) =>
  /^\d+_[ab]_(tiers_entitlements|license_entitlements)\.sql$/.test(f),
);
const DOWN = join(
  HERE,
  "..",
  "scripts",
  "rollback",
  "0160_entitlement_buckets.down.sql",
);

function populated(): Database.Database {
  const db = databaseBefore(MINE[0]!);
  db.exec(
    "INSERT INTO tiers (product, id, label, modified_at) VALUES ('p', 'pro', 'Pro', 1)",
  );
  return db;
}

const migrate = (db: Database.Database): void => applyMigrations(db, MINE);
const cols = columnsOf;

describe("entitlement buckets migration", () => {
  it("ships two files in order", () => {
    expect(MINE).toHaveLength(2);
    expect(
      (
        readFileSync(join(MIGRATIONS_DIR, MINE[0]!), "utf8").match(
          /^ALTER TABLE/gm,
        ) ?? []
      ).length,
    ).toBe(1);
  });

  it("adds an empty column to populated tiers", () => {
    const db = populated();
    migrate(db);
    expect(cols(db, "tiers")).toContain("entitlements_json");
    expect(db.prepare("SELECT entitlements_json FROM tiers").all()).toEqual([
      { entitlements_json: null },
    ]);
  });

  it("an upsert that names its columns leaves the bucket alone", () => {
    const db = populated();
    migrate(db);
    db.prepare("UPDATE tiers SET entitlements_json = '{}'").run();
    db.prepare(
      `INSERT INTO tiers (product, id, label, modified_at) VALUES ('p', 'pro', 'Pro 2', 2)
       ON CONFLICT(product, id) DO UPDATE SET label = excluded.label`,
    ).run();
    expect(
      db.prepare("SELECT label, entitlements_json FROM tiers").all(),
    ).toEqual([{ label: "Pro 2", entitlements_json: "{}" }]);
  });

  it("creates the catalog with feature defaults and a closed kind and source", () => {
    const db = populated();
    migrate(db);
    db.prepare(
      "INSERT INTO license_entitlements (product, key, modified_at) VALUES ('p', 'polarisVpn', 1)",
    ).run();
    expect(
      db
        .prepare(
          "SELECT kind, shown_to_customers, position, source FROM license_entitlements",
        )
        .all(),
    ).toEqual([
      {
        kind: "feature",
        shown_to_customers: 0,
        position: 0,
        source: "manifest",
      },
    ]);
    for (const kind of ["quantity", "consumable"])
      db.prepare(
        "INSERT INTO license_entitlements (product, key, kind, modified_at) VALUES ('p', ?, ?, 1)",
      ).run(`k_${kind}`, kind);
    expect(() =>
      db
        .prepare(
          "INSERT INTO license_entitlements (product, key, kind, modified_at) VALUES ('p', 'x', 'flag', 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO license_entitlements (product, key, source, modified_at) VALUES ('p', 'y', 'other', 1)",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO license_entitlements (product, key, modified_at) VALUES ('p', 'polarisVpn', 1)",
        )
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/);
  });

  it("creates the ledger keyed by subject and field", () => {
    const db = populated();
    migrate(db);
    const ins = db.prepare(
      "INSERT INTO entitlement_bucket_backfill (product, subject_kind, subject_id, field, run_id, at) VALUES ('p', ?, 'a', 'f', 'r', 1)",
    );
    ins.run("tier");
    ins.run("license");
    expect(() => ins.run("tier")).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run("device")).toThrow(/CHECK/);
  });

  it("is replay-safe apart from the bare ADD COLUMN", () => {
    const db = populated();
    migrate(db);
    db.exec(readFileSync(join(MIGRATIONS_DIR, MINE[1]!), "utf8"));
  });

  it("the rollback drops the three objects and keeps the rest", () => {
    const db = populated();
    migrate(db);
    db.exec(readFileSync(DOWN, "utf8"));
    expect(cols(db, "tiers")).not.toContain("entitlements_json");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).not.toContain("license_entitlements");
    expect(tables).not.toContain("entitlement_bucket_backfill");
    expect(db.prepare("SELECT id FROM tiers").all()).toEqual([{ id: "pro" }]);
  });
});
