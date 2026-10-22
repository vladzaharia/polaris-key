/**
 * LX-33.1's `0129_a_default_tier.sql` and `0129_b_index_assertion.sql` (the numbers are the lead's to
 * assign), rehearsed on a scratch SQLite: every migration before them, a populated fixture (two
 * products, tiers, licences), then the files, once statement by statement and once inside a
 * transaction. Nothing reads `tiers.implicit` yet; this proves the expand-only schema and its rollback.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import {
  stmtUpsertManifestTier,
  upsertTier,
} from "../src/core/licensing/store.js";
import { REQUIRED_INDEXES } from "../src/scheduled.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TARGET = FILES.find((f) => f.endsWith("_default_tier.sql"))!;
const ASSERTION = FILES.find(
  (f) => f.endsWith("_b_index_assertion.sql") && f > TARGET,
)!;
const DOWN = join(
  HERE,
  "..",
  "scripts",
  "rollback",
  TARGET.replace(/\.sql$/, ".down.sql"),
);
const NOW = 1_700_000_000;
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f >= TARGET) break;
    raw.exec(sql(f));
  }
  raw.pragma("foreign_keys = OFF");
  const product = raw.prepare(
    `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_device_limit, created_at, modified_at)
     VALUES (?, ?, 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, ?, ?)`,
  );
  for (const p of ["acme", "bolt"]) product.run(p, p, NOW, NOW);
  const tier = raw.prepare(
    `INSERT INTO tiers (product, id, label, policy_device_limit, modified_at) VALUES (?, ?, ?, ?, ?)`,
  );
  tier.run("acme", "pro", "Pro", 3, NOW);
  tier.run("acme", "plus", "Plus", null, NOW);
  tier.run("bolt", "pro", "Pro", 9, NOW);
  const license = raw.prepare(
    `INSERT INTO licenses (product, id, status, activated_at, tier_id, modified_at)
     VALUES (?, ?, 'active', 1, ?, 1)`,
  );
  license.run("acme", "l1", "pro");
  license.run("acme", "l2", null);
  license.run("bolt", "l3", "pro");
  return raw;
}

/** The file's statements, comments dropped, run one at a time. */
function runEach(raw: Database.Database, file: string): void {
  const body = sql(file).replace(/--[^\n]*/g, "");
  for (const stmt of body.split(/;\s*(?:\n|$)/)) {
    if (stmt.trim()) raw.prepare(stmt).run();
  }
}

function apply(raw: Database.Database, how: "each" | "transaction"): void {
  const files = [TARGET, ASSERTION];
  if (how === "each") {
    for (const f of files) runEach(raw, f);
  } else {
    raw.transaction(() => {
      for (const f of files) raw.exec(sql(f));
    })();
  }
}

function shape(raw: Database.Database): unknown[] {
  return raw
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
}

describe.each(["each", "transaction"] as const)(
  "default tier migration, applied %s",
  (how) => {
    it("leaves every existing tier at implicit = 0 and every row intact", () => {
      const raw = before();
      apply(raw, how);
      const tiers = raw
        .prepare("SELECT product, id, implicit FROM tiers ORDER BY product, id")
        .all();
      expect(tiers).toEqual([
        { product: "acme", id: "plus", implicit: 0 },
        { product: "acme", id: "pro", implicit: 0 },
        { product: "bolt", id: "pro", implicit: 0 },
      ]);
      expect(raw.prepare("SELECT COUNT(*) AS n FROM licenses").get()).toEqual({
        n: 3,
      });
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM license_limit_backfill").get(),
      ).toEqual({ n: 0 });
    });

    it("refuses a second implicit tier for a product, and allows one per product", () => {
      const raw = before();
      apply(raw, how);
      const set = raw.prepare(
        "UPDATE tiers SET implicit = 1 WHERE product = ? AND id = ?",
      );
      set.run("acme", "pro");
      expect(() => set.run("acme", "plus")).toThrow(/UNIQUE/);
      set.run("bolt", "pro");
      raw
        .prepare(
          "UPDATE tiers SET implicit = 0 WHERE product = 'acme' AND id = 'pro'",
        )
        .run();
      set.run("acme", "plus");
    });

    it("keys the ledger on (product, subject, field) and checks the subject kind", () => {
      const raw = before();
      apply(raw, how);
      const ins = raw.prepare(
        `INSERT INTO license_limit_backfill
           (product, subject_kind, subject_id, field, before_json, after_json, run_id, at)
         VALUES (?, ?, ?, ?, '5', '3', 'run1', ?)`,
      );
      ins.run("acme", "license", "l1", "device_limit", NOW);
      expect(() =>
        ins.run("acme", "license", "l1", "device_limit", NOW),
      ).toThrow(/UNIQUE|PRIMARY/);
      ins.run("acme", "license", "l1", "max_offline_days", NOW);
      ins.run("acme", "tier", "l1", "device_limit", NOW);
      expect(() =>
        ins.run("acme", "device", "l1", "device_limit", NOW),
      ).toThrow(/CHECK/);
    });

    it("records the assertion with idx_tiers_implicit, found = expected", () => {
      const raw = before();
      apply(raw, how);
      expect(
        raw
          .prepare(
            "SELECT expected, found, missing FROM schema_index_assertion",
          )
          .get(),
      ).toEqual({
        expected: REQUIRED_INDEXES.length,
        found: REQUIRED_INDEXES.length,
        missing: "",
      });
      expect(REQUIRED_INDEXES).toContain("idx_tiers_implicit");
    });
  },
);

describe("default tier migration, other writers", () => {
  it("a console upsert and a manifest upsert keep implicit = 1", async () => {
    const raw = before();
    apply(raw, "transaction");
    const db = new SqliteDb(raw);
    // The implicit tier is console-owned: the manifest upsert is a no-op on it, the console
    // upsert rewrites its columns, and neither names `implicit`.
    raw
      .prepare(
        `INSERT INTO tiers (product, id, label, implicit, modified_at, source)
         VALUES ('acme', 'default', 'Default', 1, ?, 'console')`,
      )
      .run(NOW);
    await upsertTier(db, {
      product: "acme",
      id: "default",
      label: "Default 2",
      profile_id: null,
      policy_expiry_days: null,
      policy_device_limit: 7,
      channels_json: null,
      min_version: null,
      max_version: null,
      modified_by: "op",
      modified_at: NOW + 1,
    });
    await db.batch([
      stmtUpsertManifestTier({
        product: "acme",
        id: "default",
        label: "Manifest",
        profileId: null,
        policyExpiryDays: null,
        policyDeviceLimit: 1,
        modifiedAt: NOW + 2,
      }),
    ]);
    expect(
      raw
        .prepare(
          "SELECT label, implicit, policy_device_limit FROM tiers WHERE id = 'default'",
        )
        .get(),
    ).toEqual({ label: "Default 2", implicit: 1, policy_device_limit: 7 });
  });
});

describe("default tier rollback", () => {
  it("returns sqlite_master to the pre-migration shape and keeps the data", () => {
    const raw = before();
    const pre = shape(raw);
    apply(raw, "transaction");
    expect(shape(raw)).not.toEqual(pre);
    raw.exec(readFileSync(DOWN, "utf8"));
    expect(shape(raw)).toEqual(
      // The assertion table exists before the target too; only its row (data) was replaced.
      pre,
    );
    expect(raw.prepare("SELECT COUNT(*) AS n FROM tiers").get()).toEqual({
      n: 3,
    });
  });
});
