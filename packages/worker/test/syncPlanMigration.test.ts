/**
 * ST-17's `0126_product_sync_plan.sql` (the file's number is the lead's to assign), rehearsed on a
 * scratch SQLite: every migration before it, a populated `product_sync_state` row, then the file.
 * The row survives with `plan_json` NULL, the column takes a plan, and the file is the one bare
 * `ADD COLUMN` statement the migration discipline allows (R11-04).
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const FILE = readdirSync(DIR).find((f) => /_product_sync_plan\.sql$/.test(f))!;
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const NOW = 1_700_000_000;

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) {
    if (f === FILE) break;
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
      `INSERT INTO product_sync_state (product, source, status, last_checked_at, last_synced_at, message)
       VALUES ('acme', 'webhook', 'ok', ?, ?, 'kept')`,
    )
    .run(NOW, NOW);
  return raw;
}

describe("0126_product_sync_plan.sql", () => {
  it("adds plan_json, NULL on the rows that exist, and nothing else changes", () => {
    const raw = before();
    const cols = (
      raw.prepare("PRAGMA table_info(product_sync_state)").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(cols).not.toContain("plan_json");
    raw.exec(sql(FILE));
    expect(raw.prepare("SELECT * FROM product_sync_state").all()).toEqual([
      expect.objectContaining({
        product: "acme",
        source: "webhook",
        status: "ok",
        message: "kept",
        plan_json: null,
      }),
    ]);
    raw
      .prepare("UPDATE product_sync_state SET plan_json = ?")
      .run(JSON.stringify({ v: 1 }));
    expect(
      (
        raw.prepare("SELECT plan_json FROM product_sync_state").get() as {
          plan_json: string;
        }
      ).plan_json,
    ).toBe('{"v":1}');
  });

  it("is one statement, so a replay fails on it and strands nothing", () => {
    const body = sql(FILE)
      .split("\n")
      .filter((l) => !l.startsWith("--") && l.trim() !== "")
      .join("\n");
    expect(body.match(/;/g)).toHaveLength(1);
    expect(body).toMatch(
      /^ALTER TABLE product_sync_state ADD COLUMN plan_json TEXT;$/,
    );
    const raw = before();
    raw.exec(sql(FILE));
    expect(() => raw.exec(sql(FILE))).toThrow(/duplicate column/i);
  });
});
