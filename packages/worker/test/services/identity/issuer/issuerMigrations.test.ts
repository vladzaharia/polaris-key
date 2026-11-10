/**
 * I-21.2: migrations 0162_a to 0165_d (provisional numbers) rehearsed on a scratch SQLite: every
 * earlier migration, a populated fixture, then the four files, then their down scripts. The tables
 * are additive, so the fixture's rows must survive both ways and the new tables start empty.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TABLE_OWNERS } from "../../../../src/db/owners.js";
import { TEST_ROOT } from "../../../paths.js";

const ROOT = join(TEST_ROOT, "..");
const DIR = join(ROOT, "migrations");
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const MINE = FILES.filter((f) =>
  /^016[2-5]_[a-d]_identity_(clients|issuer_keys|client_grants|refresh_tokens)\.sql$/.test(
    f,
  ),
);
const TABLES = [
  "identity_clients",
  "identity_client_secrets",
  "identity_issuer_keys",
  "identity_client_grants",
  "identity_refresh_tokens",
];
const sql = (dir: string, f: string) =>
  readFileSync(join(ROOT, dir, f), "utf8");

function before(): Database.Database {
  const raw = new Database(":memory:");
  for (const f of FILES) if (!MINE.includes(f)) raw.exec(sql("migrations", f));
  raw.pragma("foreign_keys = OFF");
  raw
    .prepare(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('acme', 'acme', 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, 1, 1)`,
    )
    .run();
  return raw;
}

const tables = (raw: Database.Database) =>
  (
    raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
  ).map((r) => r.name);

describe("issuer migrations", () => {
  it("are four files in order", () => {
    expect(MINE).toEqual([
      "0162_a_identity_clients.sql",
      "0163_b_identity_issuer_keys.sql",
      "0164_c_identity_client_grants.sql",
      "0165_d_identity_refresh_tokens.sql",
    ]);
  });

  it("apply over populated data, twice, and leave the rows alone", () => {
    const raw = before();
    for (let i = 0; i < 2; i++)
      for (const f of MINE) raw.exec(sql("migrations", f));
    expect(tables(raw)).toEqual(expect.arrayContaining(TABLES));
    expect(raw.prepare("SELECT slug FROM products").all()).toEqual([
      { slug: "acme" },
    ]);
    for (const t of TABLES)
      expect(raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).toEqual({
        n: 0,
      });
  });

  it("constrain states, types and one active or next key per product", () => {
    const raw = before();
    for (const f of MINE) raw.exec(sql("migrations", f));
    const key = (kid: string, state: string, product = "acme") =>
      raw
        .prepare(
          `INSERT INTO identity_issuer_keys (product, kid, state, sealed, n, e, created_at, published_at)
           VALUES (?, ?, ?, 's', 'n', 'e', 1, 1)`,
        )
        .run(product, kid, state);
    key("k1", "active");
    key("k2", "next");
    key("k3", "retired");
    key("k4", "retired");
    expect(() => key("k5", "active")).toThrow(/UNIQUE/);
    expect(() => key("k6", "next")).toThrow(/UNIQUE/);
    expect(() => key("k7", "bogus")).toThrow(/CHECK/);
    key("k1", "active", "other");
    const client = (id: string, key: string, type = "web") =>
      raw
        .prepare(
          `INSERT INTO identity_clients (client_id, product, key, name, type, redirect_uris_json,
             scopes_json, created_at, updated_at) VALUES (?, 'acme', ?, 'n', ?, '[]', '[]', 1, 1)`,
        )
        .run(id, key, type);
    client("cl_a", "web-app");
    expect(() => client("cl_b", "web-app")).toThrow(/UNIQUE/);
    expect(() => client("cl_c", "other", "server")).toThrow(/CHECK/);
  });

  it("have idempotent down scripts that drop only their own tables", () => {
    const raw = before();
    for (const f of MINE) raw.exec(sql("migrations", f));
    const downs = MINE.map((f) => f.replace(/\.sql$/, ".down.sql")).reverse();
    for (let i = 0; i < 2; i++)
      for (const d of downs) raw.exec(sql("scripts/rollback", d));
    const left = tables(raw);
    for (const t of TABLES) expect(left).not.toContain(t);
    expect(left).toContain("products");
  });

  it("are owned by identity", () => {
    for (const t of TABLES) expect(TABLE_OWNERS.identity).toContain(t);
  });
});
