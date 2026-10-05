/**
 * Settings coverage (ST-06, notes/S-18 §4.13 item 2): every ownership marker in the migrated
 * schema, every settings-shaped table, every `Env` member and every top-level `.pkey/` field is
 * declared by a registry entry, explained by `NOT_A_SETTING`, or listed in `PENDING` with the
 * work package that will register it. `PENDING` only shrinks: an entry that is already declared,
 * names nothing, or pushes the list past `PENDING_CEILING` fails here. ST-25 empties it.
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../src/mount.js";
import { PLATFORM_INVENTORY } from "../src/platformInventory.generated.js";
import {
  checkCoverage,
  NOT_A_SETTING,
  PENDING,
  PENDING_CEILING,
  SETTINGS_SHAPED_TABLES,
  settingsShapedTables,
  SOURCE_MARKERS,
  type CoverageTarget,
} from "../src/core/settings/coverage.js";
import { setting } from "../src/core/settings/define.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const MIGRATIONS = join(HERE, "..", "migrations");
const SCHEMAS = join(REPO, "packages", "shared-manifest", "schemas", "v1");
const WORKPACKAGES = join(
  REPO,
  "docs",
  "research",
  "2026-09-29-godot-omniplatform",
  "program",
  "workpackages.json",
);

/** The schema every migration produces: table → column names. */
function migratedSchema(): Map<string, string[]> {
  const db = new Database(":memory:");
  const runScript = db.exec.bind(db);
  for (const f of readdirSync(MIGRATIONS)
    .filter((n) => n.endsWith(".sql"))
    .sort())
    runScript(readFileSync(join(MIGRATIONS, f), "utf8"));
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    )
    .all() as { name: string }[];
  const out = new Map<string, string[]>();
  for (const { name } of tables)
    out.set(
      name,
      (
        db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
      ).map((c) => c.name),
    );
  db.close();
  return out;
}

/** The four `.pkey/` documents a product's settings come from (not the per-release descriptor). */
const DOCUMENTS = ["product", "schema", "release", "distribution"] as const;

/** Top-level fields a document may carry (a property declared `false` cannot appear). */
function manifestFields(doc: string): string[] {
  const schema = JSON.parse(
    readFileSync(join(SCHEMAS, `${doc}.schema.json`), "utf8"),
  ) as { properties?: Record<string, unknown> };
  return Object.entries(schema.properties ?? {})
    .filter(([, v]) => v !== false)
    .map(([k]) => k);
}

function collectTargets(schema: Map<string, string[]>): CoverageTarget[] {
  const targets: CoverageTarget[] = [];
  for (const [table, columns] of schema)
    for (const c of columns)
      if (/(^|_)source$/.test(c)) targets.push({ id: `column:${table}.${c}` });
  for (const t of settingsShapedTables([...schema.keys()]))
    targets.push({ id: `table:${t}` });
  for (const e of PLATFORM_INVENTORY)
    targets.push({ id: `env:${e.name}`, inventoryKind: e.kind });
  for (const doc of DOCUMENTS)
    for (const f of manifestFields(doc))
      targets.push({ id: `manifest:${doc}:${f}` });
  return targets;
}

const SCHEMA = migratedSchema();
const TARGETS = collectTargets(SCHEMA);
const WORK_PACKAGE_IDS: ReadonlySet<string> = new Set(
  (
    JSON.parse(readFileSync(WORKPACKAGES, "utf8")) as {
      workPackages: { id: string }[];
    }
  ).workPackages.map((p) => p.id),
);

describe("settings coverage (ST-06)", () => {
  it("finds every kind of target", () => {
    const kinds = new Set(TARGETS.map((t) => t.id.split(":")[0]));
    expect([...kinds].sort()).toEqual(["column", "env", "manifest", "table"]);
    // Sanity: the known homes are among them.
    const ids = new Set(TARGETS.map((t) => t.id));
    for (const id of [
      "column:products.services_source",
      "table:lazy_delta_settings",
      "env:LAZY_DELTAS",
      "manifest:product:web",
    ])
      expect(ids.has(id), id).toBe(true);
  });

  it("gives every target a home: a registry entry, NOT_A_SETTING or PENDING", () => {
    expect(
      checkCoverage({
        targets: TARGETS,
        entries: SETTINGS.entries,
        workPackages: WORK_PACKAGE_IDS,
      }),
    ).toEqual([]);
  });

  it("lists only tables and markers that exist", () => {
    for (const t of SETTINGS_SHAPED_TABLES.filter(
      (t) => t !== "product_settings",
    ))
      expect(SCHEMA.has(t), `SETTINGS_SHAPED_TABLES names ${t}`).toBe(true);
    for (const [marker, value] of Object.entries(SOURCE_MARKERS)) {
      for (const tc of [marker, value]) {
        const [table, column] = tc.split(".") as [string, string];
        expect(SCHEMA.get(table) ?? [], `SOURCE_MARKERS names ${tc}`).toContain(
          column,
        );
      }
    }
  });

  it("explains every fixed-on-purpose row with a reason and a place", () => {
    for (const n of NOT_A_SETTING) {
      expect(n.reason.length, n.thing).toBeGreaterThan(10);
      expect(n.shows.length, n.thing).toBeGreaterThan(2);
    }
  });

  it("keeps PENDING_CEILING equal to PENDING's length", () => {
    expect(PENDING.length).toBe(PENDING_CEILING);
  });
});

describe("the coverage check refuses", () => {
  const targets: CoverageTarget[] = [
    { id: "table:widgets" },
    { id: "env:WIDGET_MODE", inventoryKind: "var" },
    { id: "env:WIDGET_KEY", inventoryKind: "secret" },
  ];
  const widgets = setting({
    key: "core.widgets",
    scope: "product",
    service: "core",
    area: "test",
    label: "Widgets",
    description: "Widgets.",
    docs: "/docs/admin/products/",
    value: { kind: "json", schema: "widgets" },
    defaultValue: null,
    allowUnset: true,
    merge: "cascade",
    ownership: "operator",
    confirm: { change: "L1" },
    readers: ["core/products.ts"],
    storage: { kind: "rich", adapter: "widgets" },
  });
  const secrets = [
    {
      thing: "secrets",
      reason: "key material",
      shows: "nowhere",
      covers: { inventoryKinds: ["secret" as const] },
    },
  ];

  it("a target with no home", () => {
    const errors = checkCoverage({
      targets,
      entries: [widgets],
      notASetting: secrets,
      pending: [],
      ceiling: 0,
    });
    expect(errors).toEqual([
      "env:WIDGET_MODE has no home: register it (core/settings or a service's settings slice) or explain it in NOT_A_SETTING",
    ]);
  });

  it("an entry that is both pending and registered (the list only shrinks)", () => {
    const errors = checkCoverage({
      targets,
      entries: [widgets],
      notASetting: secrets,
      pending: [
        { target: "table:widgets", owner: "ST-11" },
        { target: "env:WIDGET_MODE", owner: "ST-11" },
      ],
      ceiling: 2,
    });
    expect(errors).toEqual([
      "PENDING lists table:widgets, which a registry entry now declares: remove it (and lower PENDING_CEILING)",
    ]);
  });

  it("a pending entry that names nothing, or is explained as not a setting", () => {
    const errors = checkCoverage({
      targets,
      entries: [widgets],
      notASetting: secrets,
      pending: [
        { target: "env:GONE", owner: "ST-11" },
        { target: "env:WIDGET_KEY", owner: "ST-11" },
        { target: "env:WIDGET_MODE", owner: "ST-11" },
      ],
      ceiling: 3,
    });
    expect(errors).toEqual([
      "PENDING lists env:GONE, which no longer exists: remove it (and lower PENDING_CEILING)",
      "PENDING lists env:WIDGET_KEY, which NOT_A_SETTING explains: remove it from one of them",
    ]);
  });

  it("a growing list, a stale ceiling, and an owner that is not a work package", () => {
    const pending = [{ target: "env:WIDGET_MODE", owner: "ZZ-99" }];
    expect(
      checkCoverage({
        targets,
        entries: [widgets],
        notASetting: secrets,
        pending,
        ceiling: 0,
        workPackages: new Set(["ST-11"]),
      }),
    ).toEqual([
      "PENDING env:WIDGET_MODE: owner ZZ-99 is not a registered work package",
      "PENDING has 1 entries, above PENDING_CEILING (0): the list only shrinks; register the setting instead",
    ]);
    expect(
      checkCoverage({
        targets,
        entries: [widgets],
        notASetting: secrets,
        pending,
        ceiling: 2,
      }),
    ).toEqual(["PENDING has 1 entries: lower PENDING_CEILING from 2 to 1"]);
  });

  it("a NOT_A_SETTING row that names a registered or missing target", () => {
    const errors = checkCoverage({
      targets,
      entries: [widgets],
      notASetting: [
        ...secrets,
        {
          thing: "widgets",
          reason: "records",
          shows: "nowhere",
          covers: { ids: ["table:widgets", "env:GONE", "env:WIDGET_MODE"] },
        },
      ],
      pending: [],
      ceiling: 0,
    });
    expect(errors).toEqual([
      'NOT_A_SETTING "widgets" names table:widgets, which a registry entry declares: remove it',
      'NOT_A_SETTING "widgets" names env:GONE, which no longer exists: remove it',
    ]);
  });

  it("declares a legacy marker through the value column it governs, and row markers through the adapter", () => {
    const compat = setting({
      ...widgets,
      key: "core.compat",
      storage: { kind: "column", table: "products", column: "compat_min" },
    });
    expect(
      checkCoverage({
        targets: [
          { id: "column:products.compat_source" },
          { id: "column:widgets.source" },
          { id: "column:widgets.capabilities_source" },
          { id: "column:products.release_source" },
        ],
        entries: [compat, widgets],
        notASetting: [],
        pending: [],
        ceiling: 0,
      }),
    ).toEqual([
      "column:products.release_source has no home: register it (core/settings or a service's settings slice) or explain it in NOT_A_SETTING",
    ]);
  });
});
