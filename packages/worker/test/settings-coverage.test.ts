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
import { DEPRECATED_SPELLINGS } from "@polaris-key/manifest";
import {
  checkCoverage,
  declaredByRegistry,
  deprecatedSpellingTargets,
  MANIFEST_WRAPPERS,
  manifestTargetId,
  NOT_A_SETTING,
  PENDING,
  PENDING_CEILING,
  SETTINGS_SHAPED_TABLES,
  settingsShapedTables,
  SOURCE_MARKERS,
  type CoverageTarget,
} from "../scripts/settings-coverage.js";
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

type SchemaNode = {
  properties?: Record<string, unknown>;
  $ref?: string;
  deprecated?: boolean;
};

function readSchema(doc: string): SchemaNode {
  return JSON.parse(
    readFileSync(join(SCHEMAS, `${doc}.schema.json`), "utf8"),
  ) as SchemaNode;
}

/** A property's schema with a local `$ref` followed. */
function deref(root: SchemaNode, node: unknown): SchemaNode {
  const n = (node ?? {}) as SchemaNode;
  if (!n.$ref?.startsWith("#/")) return n;
  let t: unknown = root;
  for (const seg of n.$ref.slice(2).split("/"))
    t = (t as Record<string, unknown>)[seg];
  return t as SchemaNode;
}

/**
 * The fields a document may carry (a property declared `false` cannot appear): the top level,
 * with each canonical wrapper (`MANIFEST_WRAPPERS`, ST-19) replaced by its own fields
 * (`licensing.tiers`, `release.provider`).
 */
function manifestFields(doc: string): string[] {
  const schema = readSchema(doc);
  const out: string[] = [];
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    if (v === false) continue;
    if (!(MANIFEST_WRAPPERS[doc] ?? []).includes(k)) {
      out.push(k);
      continue;
    }
    for (const [inner, iv] of Object.entries(deref(schema, v).properties ?? {}))
      if (iv !== false) out.push(`${k}.${inner}`);
  }
  return out;
}

/** The fields `manifestFields` lists whose schema property is marked `deprecated`. */
function deprecatedFields(doc: string): string[] {
  const schema = readSchema(doc);
  return manifestFields(doc).filter((f) => {
    const [head, inner] = f.split(".") as [string, string | undefined];
    const top = (schema.properties ?? {})[head] as SchemaNode;
    const node = inner
      ? ((deref(schema, top).properties ?? {})[inner] as SchemaNode)
      : top;
    return node?.deprecated === true;
  });
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

  it("descends into the canonical wrappers (ST-19)", () => {
    const ids = new Set(TARGETS.map((t) => t.id));
    for (const id of [
      "manifest:product:product.name",
      "manifest:product:licensing.tiers",
      "manifest:release:release.provider",
    ])
      expect(ids.has(id), id).toBe(true);
    for (const id of [
      "manifest:product:product",
      "manifest:product:licensing",
      "manifest:release:release",
    ])
      expect(ids.has(id), id).toBe(false);
    expect(manifestTargetId("product:licensing.tiers[].profileId")).toBe(
      "manifest:product:licensing.tiers",
    );
    expect(manifestTargetId("product:web.origins")).toBe(
      "manifest:product:web",
    );
  });

  it("covers the deprecated spellings with one generated row, and gives each canonical spelling a home of its own (ST-19)", () => {
    const rows = NOT_A_SETTING.filter((n) =>
      n.thing.startsWith("Deprecated manifest spellings"),
    );
    expect(rows).toHaveLength(1);
    const covered = new Set(rows[0]!.covers?.ids ?? []);
    expect([...covered].sort()).toEqual(deprecatedSpellingTargets());
    // The row is exactly the schema properties marked `deprecated` that coverage reaches.
    const marked = DOCUMENTS.flatMap((doc) =>
      deprecatedFields(doc).map((f) => `manifest:${doc}:${f}`),
    ).sort();
    expect(marked).toEqual(deprecatedSpellingTargets());
    // Each spelling's canonical target is registered, pending or explained by another row.
    const registered = declaredByRegistry(SETTINGS.entries);
    const pending = new Set(PENDING.map((p) => p.target));
    const explained = new Set(
      NOT_A_SETTING.filter((n) => n !== rows[0]).flatMap(
        (n) => n.covers?.ids ?? [],
      ),
    );
    const hasHome = (id: string) =>
      registered(id) || pending.has(id) || explained.has(id);
    for (const s of DEPRECATED_SPELLINGS) {
      const target = manifestTargetId(s.canonical);
      // A whole wrapper (row 11's `release:release`) is at home when its canonical fields are.
      const homes = TARGETS.map((t) => t.id).filter(
        (id) =>
          id === target || (id.startsWith(`${target}.`) && !covered.has(id)),
      );
      expect(
        homes.length,
        `${s.canonical} is a coverage target`,
      ).toBeGreaterThan(0);
      for (const id of homes)
        expect(
          hasHome(id) && !covered.has(id),
          `${s.canonical} (${id}) has a home of its own`,
        ).toBe(true);
    }
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
