/**
 * HA-07's `dist_listing_assets` rebuild (`0099_dist_listing_assets_manifest.sql`), replayed on a
 * POPULATED fixture: every row and every column (0083's
 * acceptance columns included) survives, the widened CHECK admits `manifest` and still refuses
 * anything else, and the file converges from the window between its DROP and its RENAME (the
 * 0017 / 0058_b discipline: D1 may run it statement by statement).
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "migrations");
const FILE = "0099_dist_listing_assets_manifest.sql";
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");
const NOW = 1_700_000_000;

/** Every migration before this one, with two listing rows (one accepted). */
function populated(): Database.Database {
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
  const row = raw.prepare(
    `INSERT INTO dist_listing_assets (product, slot, locale, blob, sha256, width, height, alpha,
       derived_from, text_allowed, source, modified_at, modified_by, accepted_sha256, accepted_at,
       accepted_by)
     VALUES ('acme', ?, ?, ?, ?, 512, 512, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  row.run(
    "play:icon",
    "",
    `blobs/sha256/${"a".repeat(64)}`,
    "a".repeat(64),
    "icon-master",
    "free",
    "import",
    NOW,
    "ci",
    "a".repeat(64),
    NOW + 1,
    "u1",
  );
  row.run(
    "icon-master",
    "en-US",
    `blobs/sha256/${"b".repeat(64)}`,
    "b".repeat(64),
    null,
    "free",
    "admin",
    NOW,
    "u2",
    null,
    null,
    null,
  );
  return raw;
}

const rows = (raw: Database.Database) =>
  raw.prepare("SELECT * FROM dist_listing_assets ORDER BY slot, locale").all();

function insertSource(raw: Database.Database, source: string): void {
  raw
    .prepare(
      `INSERT INTO dist_listing_assets (product, slot, locale, blob, sha256, alpha, text_allowed,
         source, modified_at, modified_by)
       VALUES ('acme', 'key-art', '', 'blobs/sha256/x', ?, 0, 'none', ?, ?, 'manifest')`,
    )
    .run("c".repeat(64), source, NOW);
}

describe(`${FILE}: source gains 'manifest'`, () => {
  it("exists", () => {
    expect(FILES).toContain(FILE);
  });

  it("keeps every row and column; the CHECK admits manifest and nothing new besides", () => {
    const raw = populated();
    const before = rows(raw);
    expect(() => insertSource(raw, "manifest")).toThrow(/CHECK/);
    raw.exec(sql(FILE));
    expect(rows(raw)).toEqual(before);
    insertSource(raw, "manifest");
    expect(() =>
      raw
        .prepare(
          "UPDATE dist_listing_assets SET source = 'console' WHERE slot = 'key-art'",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dist_listing_assets%'",
        )
        .all(),
    ).toEqual([{ name: "dist_listing_assets" }]);
  });

  it("converges when replayed from between its DROP and its RENAME", () => {
    const raw = populated();
    const before = rows(raw);
    const statements = sql(FILE)
      .replace(/--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const rename = statements.findIndex((s) => s.startsWith("ALTER TABLE"));
    // Die just before the rename: the original is dropped, `_v2` holds every row.
    for (const s of statements.slice(0, rename)) raw.exec(s);
    raw.exec(sql(FILE));
    expect(rows(raw)).toEqual(before);
    insertSource(raw, "manifest");
  });
});
