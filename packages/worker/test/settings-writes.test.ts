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
 * Each write is attributed to the top-level function that holds it, and must be in one of:
 *
 *   - the write path itself: `writeSetting()` and the column adapters it calls;
 *   - A-13's platform store, which the platform-settings route writes through its own versioned,
 *     audited path (ST-05 folds that route into `writeSetting()`);
 *   - the MANIFEST writer: product creation and the `.pkey/` apply (link, resync, the system
 *     product's deploy hook), which writes manifest-owned values under the claim guards ST-01b put
 *     in its SQL and audits each field (`setting.resync`); ST-17 turns it into one plan. In the
 *     shared `repo.ts` only the named builders count: any other function there that writes one
 *     fails, so a new setter cannot hide beside them;
 *   - a fixture writer: a named function kept for tests that NO module under `src/` calls.
 *
 * And every call of the manifest writer's dual builders (`setServices`, `setFingerprintPolicy`,
 * …, which can also spell a console claim) outside `repo.ts` passes the literal `"manifest"` as
 * its source: a console write of those keys is `writeSetting()`'s.
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

/**
 * The manifest writer: what each module applies, and, for a module shared with other code, the
 * only functions in it that may write (`functions`; absent: the whole module is the apply path).
 */
const MANIFEST_WRITERS: Readonly<
  Record<string, { why: string; functions?: readonly string[] }>
> = {
  "repo.ts": {
    why: 'product creation, the release_config insert at link, and the ingest\'s statement builders, called with "manifest" (checked below)',
    functions: [
      "insertProduct",
      "stmtInsertProduct",
      "stmtInsertReleaseConfig",
      "setFingerprintPolicy",
      "stmtSetFingerprintPolicy",
      "setAutoIssuePolicy",
      "stmtSetAutoIssuePolicy",
      "setServices",
      "stmtSetServices",
    ],
  },
  "services/release/resync.ts": {
    why: "the resync apply: claim-guarded in SQL (ST-01b), one `setting.resync` audit row per field",
  },
  "admin/systemProduct.ts": {
    why: "the deploy hook's bootstrap of the system product (S-18 §4.5 item 8)",
  },
};

/** Writers kept for tests, by module: no module under `src/` may call them. */
const FIXTURE_WRITERS: Readonly<Record<string, readonly string[]>> = {
  "admin/repo.ts": ["updateProduct", "stmtUpdateProduct"],
  "core/settingsClaims.ts": ["stmtClaim", "stmtDeleteClaim"],
  "repo.ts": ["setTrustPolicy"],
};

/**
 * The manifest writer's builders that can also spell a console claim (`"admin"`), with the index
 * of their `source` argument. Outside `repo.ts` every call passes the literal `"manifest"`.
 */
const DUAL_BUILDERS: Readonly<Record<string, number>> = {
  setServices: 3,
  stmtSetServices: 2,
  setFingerprintPolicy: 3,
  stmtSetFingerprintPolicy: 2,
  setAutoIssuePolicy: 3,
  stmtSetAutoIssuePolicy: 2,
};

const SETTINGS_STORES = ["product_settings", "platform_settings"] as const;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const FILES: ReadonlyMap<string, string> = new Map(
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

interface WriteSite {
  hit: string;
  at: number;
}

/** The registry-backed writes in one module's text, with where each sits. */
function writeSites(
  text: string,
  columns: ReadonlyMap<string, ReadonlySet<string>> = PROTECTED,
): WriteSite[] {
  const sites: WriteSite[] = [];
  for (const m of text.matchAll(
    /UPDATE\s+(\w+)\s+SET\b([\s\S]{0,1500}?)(?:\bWHERE\b|`|$)/g,
  )) {
    const cols = columns.get(m[1]!);
    if (!cols) continue;
    // A SET list built at run time can name any column: it counts as a write of the table.
    if (m[2]!.includes("${"))
      sites.push({ hit: `UPDATE ${m[1]} SET \${…}`, at: m.index });
    for (const c of m[2]!.matchAll(/\b(\w+)\s*=/g))
      if (cols.has(c[1]!)) sites.push({ hit: `${m[1]}.${c[1]}`, at: m.index });
  }
  for (const m of text.matchAll(
    /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)\s*\(([^)]*)\)/g,
  )) {
    const cols = columns.get(m[1]!);
    if (!cols) continue;
    if (m[2]!.includes("${"))
      sites.push({ hit: `INSERT INTO ${m[1]} (\${…})`, at: m.index });
    for (const c of m[2]!.split(",").map((x) => x.trim()))
      if (cols.has(c)) sites.push({ hit: `${m[1]}.${c}`, at: m.index });
  }
  for (const m of text.matchAll(
    /(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+(\w+)\b/g,
  ))
    if ((SETTINGS_STORES as readonly string[]).includes(m[2]!))
      sites.push({ hit: `${m[1]!.split(/\s+/)[0]} ${m[2]}`, at: m.index });
  return sites;
}

/** The registry-backed writes in one module's text, as readable strings. */
export function settingWrites(
  text: string,
  columns: ReadonlyMap<string, ReadonlySet<string>> = PROTECTED,
): string[] {
  return [...new Set(writeSites(text, columns).map((s) => s.hit))].sort();
}

/** The top-level function (or const) enclosing `at`, `(module)` above the first one. */
function enclosing(text: string, at: number): string {
  let name = "(module)";
  for (const m of text.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[=:])/gm,
  )) {
    if (m.index > at) break;
    name = (m[1] ?? m[2])!;
  }
  return name;
}

/** Every write in `files` that no rule above allows, as `file fn: hit`. */
export function offendingWrites(files: ReadonlyMap<string, string>): string[] {
  const whole = new Set<string>([
    ...WRITE_PATH,
    ...A13_STORE,
    ...Object.entries(MANIFEST_WRITERS)
      .filter(([, w]) => !w.functions)
      .map(([f]) => f),
  ]);
  const out: string[] = [];
  for (const [file, text] of files) {
    if (whole.has(file)) continue;
    const allowed = new Set([
      ...(MANIFEST_WRITERS[file]?.functions ?? []),
      ...(FIXTURE_WRITERS[file] ?? []),
    ]);
    for (const site of writeSites(text)) {
      const fn = enclosing(text, site.at);
      if (!allowed.has(fn)) out.push(`${file} ${fn}: ${site.hit}`);
    }
  }
  return [...new Set(out)].sort();
}

/** Each call of `name(` in `text` that is not its own definition, as its argument list. */
function callArgs(name: string, text: string): string[][] {
  const out: string[][] = [];
  for (const m of text.matchAll(new RegExp(`(^|[^\\w.])${name}\\(`, "g"))) {
    const open = m.index + m[0].length - 1;
    const head = text.slice(
      Math.max(0, open - name.length - 40),
      open - name.length,
    );
    if (/function\s*$/.test(head)) continue;
    // Split the balanced argument list on its top-level commas.
    const args: string[] = [];
    let depth = 0;
    let cur = "";
    for (let i = open + 1; i < text.length; i++) {
      const ch = text[i]!;
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) {
        if (depth === 0) break;
        depth--;
      }
      if (ch === "," && depth === 0) {
        args.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim() !== "") args.push(cur.trim());
    out.push(args);
  }
  return out;
}

/** Every dual-builder call outside `repo.ts` whose source is not the literal `"manifest"`. */
export function nonManifestDualCalls(
  files: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [file, text] of files) {
    if (file === "repo.ts") continue;
    for (const [name, index] of Object.entries(DUAL_BUILDERS))
      for (const args of callArgs(name, text))
        if (args[index] !== '"manifest"')
          out.push(`${file}: ${name}(…, ${args[index] ?? "?"}, …)`);
  }
  return out.sort();
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

  it("finds a direct write, attributes it to its function, and finds a non-manifest dual call (the scan bites)", () => {
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

    // A new setter beside the manifest writer's builders in `repo.ts` is caught by name.
    const repo = `${FILES.get("repo.ts")!}
export async function revertServicesToManifest(db: Db, product: string, at: number) {
  await db.run(\`UPDATE products SET services_source = 'manifest', modified_at = ? WHERE slug = ?\`, at, product);
}
`;
    expect(offendingWrites(new Map([["repo.ts", repo]]))).toEqual([
      "repo.ts revertServicesToManifest: products.services_source",
    ]);
    // A handler handing a dual builder a non-literal (or console) source is caught too.
    expect(
      nonManifestDualCalls(
        new Map([
          [
            "admin/handlers/x.ts",
            `await setFingerprintPolicy(db, slug, JSON.stringify(p), source, now);
             stmtSetServices(slug, json, "admin", now);
             stmtSetAutoIssuePolicy(slug, json, "manifest", now);`,
          ],
        ]),
      ),
    ).toEqual([
      "admin/handlers/x.ts: setFingerprintPolicy(…, source, …)",
      'admin/handlers/x.ts: stmtSetServices(…, "admin", …)',
    ]);
  });

  it("no module writes one outside the write path, A-13's store, the manifest writer and fixture writers", () => {
    expect(
      offendingWrites(FILES),
      "write these through writeSetting() (core/settings/write.ts)",
    ).toEqual([]);
  });

  it("keeps the allow-list honest: every listed module and function still writes one", () => {
    for (const file of [
      ...WRITE_PATH,
      ...A13_STORE,
      ...Object.keys(MANIFEST_WRITERS),
      ...Object.keys(FIXTURE_WRITERS),
    ]) {
      expect(FILES.has(file), `${file} exists`).toBe(true);
      expect(settingWrites(FILES.get(file)!), file).not.toEqual([]);
    }
    for (const [file, w] of Object.entries(MANIFEST_WRITERS)) {
      const text = FILES.get(file)!;
      const writing = new Set(
        writeSites(text).map((s) => enclosing(text, s.at)),
      );
      for (const fn of w.functions ?? []) {
        expect(text.includes(`function ${fn}(`), `${file} defines ${fn}`).toBe(
          true,
        );
        // A builder may delegate to its `stmt…` twin; one of the pair holds the SQL.
        const twin = `stmt${fn[0]!.toUpperCase()}${fn.slice(1)}`;
        expect(
          writing.has(fn) || writing.has(twin),
          `${file} ${fn} writes (itself or through ${twin})`,
        ).toBe(true);
      }
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
          .filter(([, text]) => callArgs(name, text).length > 0)
          .map(([file]) => file)
          // `updateProduct` calls `stmtUpdateProduct` inside the same fixture module.
          .filter((file) => file !== owner);
        expect(callers, `${name} is a fixture writer`).toEqual([]);
      }
  });

  it('passes the literal "manifest" to every dual builder outside repo.ts', () => {
    expect(nonManifestDualCalls(FILES)).toEqual([]);
    // And there are such calls to check (the ingest, link and resync).
    const calls = [...FILES]
      .filter(([file]) => file !== "repo.ts")
      .flatMap(([, text]) =>
        Object.keys(DUAL_BUILDERS).flatMap((n) => callArgs(n, text)),
      );
    expect(calls.length).toBeGreaterThan(3);
  });
});
