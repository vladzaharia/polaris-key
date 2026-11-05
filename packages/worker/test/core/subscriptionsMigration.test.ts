// LX-41.2 (plans/LX-41.md §6.1): the subscriptions table, its triggers and indexes, applied to a
// populated pre-migration database. Nothing reads the table yet; this pins the schema.
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_ROOT as HERE } from "../paths.js";
import { REQUIRED_INDEXES } from "../../src/scheduled.js";

const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TABLE_FILE = FILES.find((f) => /^\d+_d_subscriptions\.sql$/.test(f))!;
const ASSERT_FILE = FILES.filter((f) =>
  f.endsWith("_index_assertion.sql"),
).pop()!;

function populated(): Database.Database {
  const db = new Database(":memory:");
  for (const f of FILES) {
    if (f >= TABLE_FILE) break;
    db.exec(readFileSync(join(DIR, f), "utf8"));
  }
  db.pragma("foreign_keys = OFF");
  db.exec(`
    INSERT INTO licenses (product, id, status, activated_at, modified_at)
      VALUES ('p', 'lic_a', 'active', 1, 1), ('p', 'lic_b', 'active', 1, 1);`);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(readFileSync(join(DIR, TABLE_FILE), "utf8"));
}

let n = 0;
function insert(
  db: Database.Database,
  o: Partial<{
    id: string;
    license: string | null;
    grant: string | null;
    source: string;
    ref: string | null;
    status: string;
    product: string;
  }> = {},
): void {
  db.prepare(
    `INSERT INTO subscriptions (product, id, license_id, grant_id, source, external_ref_hash, status,
       period, current_period_end, created_at, modified_at, modified_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'P1M', 100, 1, 1, 'test')`,
  ).run(
    o.product ?? "p",
    o.id ?? `sub_${n++}`,
    "license" in o ? o.license : "lic_a",
    o.grant ?? null,
    o.source ?? "manual",
    o.ref ?? null,
    o.status ?? "active",
  );
}

describe("subscriptions migration", () => {
  it("creates the table beside populated licences, touching none", () => {
    const db = populated();
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM subscriptions").get()).toEqual(
      { c: 0 },
    );
    expect(db.prepare("SELECT COUNT(*) AS c FROM licenses").get()).toEqual({
      c: 2,
    });
    insert(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM subscriptions").get()).toEqual(
      { c: 1 },
    );
  });

  it("is replay-safe", () => {
    const db = populated();
    migrate(db);
    insert(db);
    migrate(db);
    expect(db.prepare("SELECT COUNT(*) AS c FROM subscriptions").get()).toEqual(
      { c: 1 },
    );
  });

  it("targets exactly one of a licence or a grant", () => {
    const db = populated();
    migrate(db);
    expect(() => insert(db, { license: null, grant: null })).toThrow(/CHECK/);
    expect(() => insert(db, { license: "lic_a", grant: "g1" })).toThrow(
      /CHECK/,
    );
    insert(db, { license: null, grant: "g1" });
  });

  it("allows one live subscription per licence, and a new one after expiry", () => {
    const db = populated();
    migrate(db);
    insert(db, { id: "s1" });
    expect(() => insert(db, { id: "s2" })).toThrow(/UNIQUE/);
    insert(db, { id: "s3", license: "lic_b" });
    db.prepare(
      "UPDATE subscriptions SET status = 'expired' WHERE id = 's1'",
    ).run();
    insert(db, { id: "s4" });
    insert(db, { id: "s5", status: "expired" });
    expect(() => insert(db, { id: "s6", status: "canceled" })).toThrow(
      /UNIQUE/,
    );
  });

  it("allows one live subscription per grant", () => {
    const db = populated();
    migrate(db);
    insert(db, { id: "g1", license: null, grant: "gr" });
    expect(() =>
      insert(db, { id: "g2", license: null, grant: "gr", status: "past_due" }),
    ).toThrow(/UNIQUE/);
    db.prepare(
      "UPDATE subscriptions SET status = 'expired' WHERE id = 'g1'",
    ).run();
    insert(db, { id: "g3", license: null, grant: "gr" });
  });

  it("keeps an external reference unique per product and source", () => {
    const db = populated();
    migrate(db);
    insert(db, { id: "r1", source: "external", ref: "h1" });
    expect(() =>
      insert(db, { id: "r2", license: "lic_b", source: "external", ref: "h1" }),
    ).toThrow(/UNIQUE/);
    insert(db, { id: "r3", license: "lic_b", source: "play", ref: "h1" });
    insert(db, {
      id: "r4",
      product: "q",
      license: "lic_a",
      source: "external",
      ref: "h1",
    });
    insert(db, {
      id: "r5",
      license: null,
      grant: "x",
      source: "external",
      ref: null,
    });
    insert(db, {
      id: "r6",
      license: null,
      grant: "y",
      source: "external",
      ref: null,
    });
  });

  it("holds the source and status vocabularies, on insert and update", () => {
    const db = populated();
    migrate(db);
    for (const s of [
      "manual",
      "external",
      "app-store",
      "play",
      "polaris-key",
    ]) {
      insert(db, { id: `src_${s}`, license: null, grant: s, source: s });
    }
    for (const s of ["trialing", "active", "past_due", "canceled", "expired"]) {
      insert(db, { id: `st_${s}`, license: null, grant: `g_${s}`, status: s });
    }
    expect(() => insert(db, { license: "lic_b", source: "stripe" })).toThrow(
      /subscriptions\.source/,
    );
    expect(() => insert(db, { license: "lic_b", status: "paused" })).toThrow(
      /subscriptions\.status/,
    );
    expect(() =>
      db
        .prepare(
          "UPDATE subscriptions SET source = 'Manual' WHERE id = 'src_play'",
        )
        .run(),
    ).toThrow(/subscriptions\.source/);
    expect(() =>
      db
        .prepare("UPDATE subscriptions SET status = '' WHERE id = 'st_active'")
        .run(),
    ).toThrow(/subscriptions\.status/);
  });

  it("indexes the due scan", () => {
    const db = populated();
    migrate(db);
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'idx_subscriptions_due'",
      )
      .get() as { sql: string };
    expect(idx.sql).toMatch(/\(product, status, current_period_end\)/);
  });

  it("the newest index assertion passes with the new indexes and aborts without one", () => {
    const db = populated();
    for (const f of FILES) {
      if (f > ASSERT_FILE) break;
      if (f < TABLE_FILE) continue;
      db.exec(readFileSync(join(DIR, f), "utf8"));
    }
    expect(
      db.prepare("SELECT expected, found FROM schema_index_assertion").get(),
    ).toEqual({
      expected: REQUIRED_INDEXES.length,
      found: REQUIRED_INDEXES.length,
    });
    db.exec("DROP INDEX idx_subscriptions_grant_live");
    expect(() => db.exec(readFileSync(join(DIR, ASSERT_FILE), "utf8"))).toThrow(
      /required_indexes_are_missing/,
    );
  });
});
