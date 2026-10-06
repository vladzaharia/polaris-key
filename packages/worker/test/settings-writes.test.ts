/**
 * No handler writes a registry-backed setting outside `writeSetting()` (ST-04, notes/S-18 §4.6:
 * "one write path").
 *
 * The scan reads every module under `src/` for SQL that writes:
 *
 *   - a column a live column-backed registry entry is stored in (every column its adapter reads:
 *     the value, a legacy `*_source` marker, `discover_enabled` beside the listing state);
 *   - `product_settings` or `platform_settings` at all (the settings stores).
 *
 * Each module that does must be one of:
 *
 *   - the write path itself: `writeSetting()` and the column adapters it calls;
 *   - A-13's platform store, which the platform-settings route writes through its own versioned,
 *     audited path (ST-05 folds that route into `writeSetting()`);
 *   - the MANIFEST writer: product creation and the `.pkey/` apply (link, resync, the system
 *     product's deploy hook), which writes manifest-owned values under the claim guards ST-01b put
 *     in its SQL and audits each field (`setting.resync`); ST-17 turns it into one plan;
 *   - a fixture writer: a function kept for tests that NO module under `src/` calls.
 *
 * And the manifest writer's statement builders are never called with their console spelling
 * (`"admin"`) from `src/`: a console write of those keys is `writeSetting()`'s.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../src/mount.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

/** `writeSetting()` and the column adapters only it calls. */
const WRITE_PATH = [
  "core/settings/write.ts",
  "core/settings/columns.ts",
  "services/release/settingsColumns.ts",
] as const;

/** A-13's store (`writePlatformSetting`), the platform-settings route's own versioned path. */
const A13_STORE = ["core/platformSettings.ts"] as const;

/** The manifest writer, with what each module applies. */
const MANIFEST_WRITERS: Readonly<Record<string, string>> = {
  "repo.ts":
    'product creation (`stmtInsertProduct`, the release_config insert) and the ingest\'s statement builders, called with `"manifest"`',
  "services/release/resync.ts":
    "the resync apply: claim-guarded in SQL (ST-01b), one `setting.resync` audit row per field",
  "admin/systemProduct.ts":
    "the deploy hook's bootstrap of the system product (S-18 §4.5 item 8)",
};

/** Writers kept for tests, by module: no module under `src/` may call them. */
const FIXTURE_WRITERS: Readonly<Record<string, readonly string[]>> = {
  "admin/repo.ts": ["updateProduct", "stmtUpdateProduct"],
  "core/settingsClaims.ts": ["stmtClaim", "stmtDeleteClaim"],
  "repo.ts": ["setTrustPolicy"],
};

/** The manifest writer's builders that also spell a console write (`"admin"`). */
const DUAL_BUILDERS = [
  "setServices",
  "stmtSetServices",
  "setFingerprintPolicy",
  "stmtSetFingerprintPolicy",
  "setAutoIssuePolicy",
  "stmtSetAutoIssuePolicy",
] as const;

const SETTINGS_STORES = ["product_settings", "platform_settings"] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const FILES = new Map(
  walk(SRC).map((p) => [
    relative(SRC, p).split(sep).join("/"),
    readFileSync(p, "utf8"),
  ]),
);

/** Every table → the columns a live column-backed entry is stored in (its adapter's columns). */
function protectedColumns(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of SETTINGS.entries) {
    if (e.pending || e.storage.kind !== "column") continue;
    const a = SETTINGS.columnAdapter(e.key);
    if (!a) continue;
    let cols = out.get(a.table);
    if (!cols) out.set(a.table, (cols = new Set()));
    for (const c of a.columns) cols.add(c);
  }
  return out;
}

const PROTECTED = protectedColumns();

/** The registry-backed writes in one module's text, as readable strings. */
export function settingWrites(
  text: string,
  columns: ReadonlyMap<string, ReadonlySet<string>> = PROTECTED,
): string[] {
  const hits = new Set<string>();
  for (const m of text.matchAll(
    /UPDATE\s+(\w+)\s+SET\b([\s\S]{0,1500}?)(?:\bWHERE\b|`|$)/g,
  )) {
    const cols = columns.get(m[1]!);
    if (!cols) continue;
    // A SET list built at run time can name any column: it counts as a write of the table.
    if (m[2]!.includes("${")) hits.add(`UPDATE ${m[1]} SET \${…}`);
    for (const c of m[2]!.matchAll(/\b(\w+)\s*=/g))
      if (cols.has(c[1]!)) hits.add(`${m[1]}.${c[1]}`);
  }
  for (const m of text.matchAll(
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/g,
  )) {
    const cols = columns.get(m[1]!);
    if (!cols) continue;
    if (m[2]!.includes("${")) hits.add(`INSERT INTO ${m[1]} (\${…})`);
    for (const c of m[2]!.split(",").map((x) => x.trim()))
      if (cols.has(c)) hits.add(`${m[1]}.${c}`);
  }
  for (const m of text.matchAll(
    /(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)\b/g,
  ))
    if ((SETTINGS_STORES as readonly string[]).includes(m[2]!))
      hits.add(`${m[1]!.split(/\s+/)[0]} ${m[2]}`);
  return [...hits].sort();
}

/** Calls of `name(` in `text` that are not its own definition. */
function callsOf(name: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(`(^|[^\\w.])${name}\\(`, "g"))) {
    const before = text.slice(Math.max(0, m.index - 20), m.index + 1);
    if (/function\s*$/.test(before)) continue;
    out.push(text.slice(m.index, m.index + 400).split(";")[0]!);
  }
  return out;
}

describe("settings writes go through writeSetting() (ST-04)", () => {
  it("protects every live column-backed entry's columns and both settings stores", () => {
    expect(PROTECTED.get("products")?.has("name")).toBe(true);
    expect(PROTECTED.get("products")?.has("services_source")).toBe(true);
    expect(PROTECTED.get("portal_product_settings")?.has("store_listed")).toBe(
      true,
    );
    expect(PROTECTED.get("release_config")?.has("metadata_access")).toBe(true);
  });

  it("gives every live column-backed entry an adapter that names its table and column", () => {
    for (const e of SETTINGS.entries) {
      if (e.pending || e.storage.kind !== "column") continue;
      const a = SETTINGS.columnAdapter(e.key);
      expect(a, e.key).toBeDefined();
      expect(a!.table, e.key).toBe(e.storage.table);
      expect(a!.columns, e.key).toContain(e.storage.column);
      // A key the console may write has a writer; a manifest-only one may have none.
      if (e.ownership === "operator" || e.ownership === "claimable")
        expect(a!.set, `${e.key} has no writer`).toBeTypeOf("function");
    }
  });

  it("finds a handler's direct write (the scan bites)", () => {
    expect(
      settingWrites("db.run(`UPDATE products SET name = ? WHERE slug = ?`)"),
    ).toEqual(["products.name"]);
    expect(
      settingWrites(
        "`INSERT INTO portal_product_settings (product, store_audience) VALUES (?, ?)`",
      ),
    ).toEqual(["portal_product_settings.store_audience"]);
    expect(
      settingWrites("`UPDATE products SET ${sets.join(', ')} WHERE slug = ?`"),
    ).toEqual(["UPDATE products SET ${…}"]);
    expect(
      settingWrites("`DELETE FROM product_settings WHERE product = ?`"),
    ).toEqual(["DELETE product_settings"]);
    // Columns no entry is stored in are not settings writes.
    expect(
      settingWrites("`UPDATE products SET branding_json = ? WHERE slug = ?`"),
    ).toEqual([]);
  });

  it("no module outside the write path, A-13's store, the manifest writer and fixture writers writes one", () => {
    const allowed = new Set<string>([
      ...WRITE_PATH,
      ...A13_STORE,
      ...Object.keys(MANIFEST_WRITERS),
      ...Object.keys(FIXTURE_WRITERS),
    ]);
    const offenders = [...FILES]
      .filter(([file]) => !allowed.has(file))
      .map(([file, text]) => [file, settingWrites(text)] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([file, hits]) => `${file}: ${hits.join(", ")}`);
    expect(
      offenders,
      "write these through writeSetting() (core/settings/write.ts)",
    ).toEqual([]);
  });

  it("keeps the allow-list honest: every listed module still writes one", () => {
    for (const file of [
      ...WRITE_PATH,
      ...A13_STORE,
      ...Object.keys(MANIFEST_WRITERS),
      ...Object.keys(FIXTURE_WRITERS),
    ]) {
      expect(FILES.has(file), `${file} exists`).toBe(true);
      expect(settingWrites(FILES.get(file)!), file).not.toEqual([]);
    }
  });

  it("calls no fixture writer from src/", () => {
    for (const [owner, names] of Object.entries(FIXTURE_WRITERS))
      for (const name of names) {
        expect(
          FILES.get(owner)!.includes(`function ${name}(`),
          `${owner} defines ${name}`,
        ).toBe(true);
        const callers = [...FILES]
          .filter(([, text]) => callsOf(name, text).length > 0)
          .map(([file]) => file)
          // `updateProduct` calls `stmtUpdateProduct` inside the same fixture module.
          .filter((file) => file !== owner);
        expect(callers, `${name} is a fixture writer`).toEqual([]);
      }
  });

  it("never spells a console write through the manifest writer's builders", () => {
    const consoleCalls = [...FILES].flatMap(([file, text]) =>
      DUAL_BUILDERS.flatMap((name) =>
        callsOf(name, text)
          .filter((call) => call.includes('"admin"'))
          .map((call) => `${file}: ${call.replace(/\s+/g, " ").slice(0, 80)}`),
      ),
    );
    expect(consoleCalls).toEqual([]);
  });
});
