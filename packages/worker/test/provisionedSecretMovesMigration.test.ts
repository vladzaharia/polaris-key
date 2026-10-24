/**
 * U-27.6's `0133_provisioned_secret_moves.sql` (the number is the lead's to assign), rehearsed on
 * a scratch SQLite: every migration before it, a populated fixture, then the file, once statement
 * by statement and once inside a transaction. Expand-only; the down script restores `sqlite_master`.
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const TARGET = FILES.find((f) => f.endsWith("_provisioned_secret_moves.sql"))!;
const DOWN = join(
  HERE,
  "..",
  "scripts",
  "rollback",
  TARGET.replace(/\.sql$/, ".down.sql"),
);
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const NOW = 1_700_000_000;

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f >= TARGET) break;
    raw.exec(sql(f));
  }
  raw
    .prepare(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('acme', 'acme', 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, ?, ?)`,
    )
    .run(NOW, NOW);
  raw
    .prepare(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at)
       VALUES ('acme', 'l1', 'active', 1, 1)`,
    )
    .run();
  return raw;
}

function runEach(raw: Database.Database, file: string): void {
  const body = sql(file).replace(/--[^\n]*/g, "");
  for (const stmt of body.split(/;\s*(?:\n|$)/))
    if (stmt.trim()) raw.prepare(stmt).run();
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
  "0133_provisioned_secret_moves.sql, applied %s",
  (how) => {
    const apply = (raw: Database.Database): void => {
      if (how === "each") runEach(raw, TARGET);
      else raw.transaction(() => raw.exec(sql(TARGET)))();
    };

    it("creates the empty ledger, keyed by product first, and touches no row", () => {
      const raw = before();
      apply(raw);
      const cols = raw
        .prepare("PRAGMA table_info(provisioned_secret_moves)")
        .all() as { name: string; pk: number }[];
      expect(cols.filter((c) => c.pk > 0).map((c) => c.name)).toEqual([
        "product",
        "license_id",
        "key",
      ]);
      // No column can hold a value: the ledger stores ids, a hash and counters.
      expect(cols.map((c) => c.name).sort()).toEqual(
        [
          "added_to_account",
          "at",
          "entry_sha256",
          "key",
          "license_id",
          "position",
          "product",
          "run_id",
          "shadowed",
          "subject",
        ].sort(),
      );
      expect(
        raw.prepare("SELECT COUNT(*) AS n FROM provisioned_secret_moves").get(),
      ).toEqual({ n: 0 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM licenses").get()).toEqual({
        n: 1,
      });
    });

    it("is replay-safe, and its down script restores sqlite_master", () => {
      const raw = before();
      const original = shape(raw);
      apply(raw);
      raw.exec(sql(TARGET)); // a replay changes nothing
      expect(shape(raw)).not.toEqual(original);
      raw.exec(readFileSync(DOWN, "utf8"));
      expect(shape(raw)).toEqual(original);
      raw.exec(readFileSync(DOWN, "utf8")); // idempotent
    });
  },
);
