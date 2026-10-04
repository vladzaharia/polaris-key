/**
 * F-03's migrations (plans/F-01.md §6.4), replayed on a POPULATED fixture: the database as it
 * stands before 0055, holding an app and a pack deliverable with channel policy and a pack floor
 * (the two tables with foreign keys into `release_deliverables`), then 0055_a..d.
 *
 *   - 0055_b's rebuild keeps every row of every table it touches, and every foreign key holds;
 *   - it runs both inside a transaction (D1 runs a migration in an implicit one) and statement by
 *     statement (the harness and a D1 that does not), with foreign keys enforced;
 *   - it converges from the window between its DROP and its RENAME (the 0017 discipline);
 *   - the widened CHECK admits `package` and still refuses package columns on the app.
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
const BEFORE = FILES.filter((f) => f < "0055");
const F03 = FILES.filter((f) => f.startsWith("0055_"));
const AFTER = FILES.filter((f) => f > "0055_z");
const REBUILD = "0055_b_release_deliverables_kind.sql";
const sql = (f: string) => readFileSync(join(DIR, f), "utf8");

const NOW = 1_700_000_000;

/** The database at 0054, with every release table the rebuild touches populated. */
function populated(): Database.Database {
  const raw = new Database(":memory:");
  expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
  for (const f of BEFORE) raw.exec(sql(f));
  const run = (q: string, ...p: unknown[]) => raw.prepare(q).run(...p);
  for (const slug of ["acme", "dice"]) {
    run(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES (?, ?, 'kid', 'pub', '0.0.0', '99.0.0', 30, 5, ?, ?)`,
      slug,
      slug,
      NOW,
      NOW,
    );
    run(
      `INSERT INTO release_deliverables (product, deliverable_id, kind, pack_type, def_json,
         def_source, created_at, modified_at)
       VALUES (?, 'app', 'app', NULL, '{"kind":"app"}', 'manifest', ?, ?),
              (?, 'acme.levels', 'pack', 'files.tree', '{"kind":"pack"}', 'manifest', ?, ?)`,
      slug,
      NOW,
      NOW,
      slug,
      NOW,
      NOW,
    );
    run(
      `INSERT INTO release_metadata (product, release_id, version, metadata_access,
         artifacts_access, created_at, modified_at, deliverable_id, seq)
       VALUES (?, 'v1.0.0', '1.0.0', 'public', 'public', ?, ?, 'app', 1)`,
      slug,
      NOW,
      NOW,
    );
    for (const [deliverable, channel, pointer] of [
      ["app", "stable", "v1.0.0"],
      ["app", "beta", null],
      ["acme.levels", "stable", null],
    ] as const)
      run(
        `INSERT INTO release_channel_policy (product, deliverable_id, channel,
           pointer_release_id, pinned, includes_json, source, created_at, modified_at)
         VALUES (?, ?, ?, ?, 0, NULL, 'admin', ?, ?)`,
        slug,
        deliverable,
        channel,
        pointer,
        NOW,
        NOW,
      );
    run(
      `INSERT INTO release_pack_floors (product, deliverable_id, channel, content_api,
         min_version, created_at, modified_at)
       VALUES (?, 'acme.levels', 'stable', 3, '1.2.0', ?, ?)`,
      slug,
      NOW,
      NOW,
    );
  }
  return raw;
}

const count = (raw: Database.Database, table: string) =>
  (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
    .n;

const snapshot = (raw: Database.Database) => ({
  deliverables: raw
    .prepare(
      `SELECT product, deliverable_id, kind, pack_type, def_json, def_source, created_at,
              modified_at FROM release_deliverables ORDER BY product, deliverable_id`,
    )
    .all(),
  policy: raw
    .prepare(
      "SELECT * FROM release_channel_policy ORDER BY product, deliverable_id, channel",
    )
    .all(),
  floors: raw
    .prepare("SELECT * FROM release_pack_floors ORDER BY product")
    .all(),
});

function expectHealthy(
  raw: Database.Database,
  before: ReturnType<typeof snapshot>,
) {
  expect(snapshot(raw)).toEqual(before);
  expect(raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(raw.prepare("PRAGMA integrity_check").pluck().get()).toBe("ok");
  // No set-aside or intermediate table survives.
  const strays = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE '%_f03' OR name LIKE '%_v2')",
    )
    .pluck()
    .all();
  expect(strays).toEqual([]);
}

describe("0055 migrations on a populated database (F-03)", () => {
  it("the rebuild keeps every row and foreign key, run as one transaction (D1)", () => {
    const raw = populated();
    const before = snapshot(raw);
    expect(before.policy).toHaveLength(6);
    raw.exec(sql("0055_a_products_system.sql"));
    raw.exec("BEGIN");
    raw.exec(sql(REBUILD));
    raw.exec("COMMIT");
    expectHealthy(raw, before);
    for (const f of F03.filter((f) => f > REBUILD)) raw.exec(sql(f));
    for (const f of AFTER) raw.exec(sql(f));
    expect(count(raw, "release_deliverables")).toBe(4);
  });

  it("the rebuild keeps every row and foreign key, run statement by statement", () => {
    const raw = populated();
    const before = snapshot(raw);
    for (const f of F03) raw.exec(sql(f));
    expectHealthy(raw, before);
    expect(
      raw.prepare("SELECT system FROM products ORDER BY slug").pluck().all(),
    ).toEqual([0, 0]);
  });

  it("converges when a run dies between the DROP and the RENAME", () => {
    const raw = populated();
    const before = snapshot(raw);
    raw.exec(sql("0055_a_products_system.sql"));
    const text = sql(REBUILD);
    const cut = text.indexOf("ALTER TABLE release_deliverables_v2 RENAME");
    expect(cut).toBeGreaterThan(0);
    raw.exec(text.slice(0, cut));
    expect(
      raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'release_deliverables'",
        )
        .all(),
    ).toEqual([]);
    // The replay: the whole file again.
    raw.exec(text);
    expectHealthy(raw, before);
  });

  it("the widened CHECK admits a package and keeps the app and packs free of package columns", () => {
    const raw = populated();
    for (const f of F03) raw.exec(sql(f));
    raw
      .prepare(
        `INSERT INTO release_deliverables (product, deliverable_id, kind, def_json, created_at,
           modified_at, ecosystem, package_name)
         VALUES ('acme', 'npm.sdk', 'package', '{}', ?, ?, 'npm', '@acme/sdk')`,
      )
      .run(NOW, NOW);
    expect(() =>
      raw
        .prepare(
          `UPDATE release_deliverables SET ecosystem = 'npm' WHERE product = 'acme' AND deliverable_id = 'app'`,
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO release_deliverables (product, deliverable_id, kind, created_at, modified_at)
           VALUES ('acme', 'x.thing', 'widget', ?, ?)`,
        )
        .run(NOW, NOW),
    ).toThrow(/CHECK/);
  });

  it("seeds the registry policy and pins upstream to none", () => {
    const raw = populated();
    for (const f of F03) raw.exec(sql(f));
    expect(
      raw
        .prepare(
          "SELECT ecosystem, max_package_bytes_ceiling FROM dist_registry_policy ORDER BY ecosystem",
        )
        .all(),
    ).toEqual([
      { ecosystem: "godot", max_package_bytes_ceiling: 52428800 },
      { ecosystem: "maven", max_package_bytes_ceiling: 52428800 },
      { ecosystem: "npm", max_package_bytes_ceiling: 52428800 },
      { ecosystem: "oci", max_package_bytes_ceiling: 5368709120 },
      { ecosystem: "pypi", max_package_bytes_ceiling: 52428800 },
      { ecosystem: "swift", max_package_bytes_ceiling: 52428800 },
    ]);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO dist_registry_feeds (product, ecosystem, namespace_json, max_package_bytes,
             upstream, updated_at) VALUES ('acme', 'npm', '{}', 1, 'npmjs', ?)`,
        )
        .run(NOW),
    ).toThrow(/CHECK/);
    // The idempotent files replay as no-ops.
    raw.exec(sql("0055_c_release_packages.sql"));
    raw.exec(sql("0055_d_registry.sql"));
    expect(count(raw, "dist_registry_policy")).toBe(6);
  });
});
