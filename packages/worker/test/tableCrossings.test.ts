/**
 * Table ownership, enforced (P0-18; P0-48 wrote the report this replaced).
 *
 * Rule 6's import test (`boundaries.test.ts`) polices imports, not SQL: a service that never
 * imports another can still read and write the other's tables. `TABLE_OWNERS` (`src/db/owners.ts`)
 * says who owns each table; this file scans the SQL in `src/` (comments stripped; the upper-case
 * `FROM`, `JOIN`, `INTO`, `UPDATE`, `DELETE FROM` and `TABLE` keywords) and fails on any use the
 * allow-lists below do not name.
 *
 *  1. Table crossings: a service touches (reads or writes) a table another service owns.
 *     Allow-list `SEAMS`. Core's tables are shared substrate and not a crossing.
 *  2. Writer location: Core or the console writes (INSERT, UPDATE, DELETE) a table a service
 *     owns. Allow-list `WRITE_SEAMS`, by file. A service writing Core's tables is not scanned here
 *     (the audit table has its own grep test, `auditWriter.test.ts`).
 *
 * Both lists only shrink. An entry that no longer matches fails the test ("delete it"), so a
 * package that removes a crossing also removes its row. Every row names `removedBy`: the package
 * that removes it, or `permanent` for a declared seam. Seeded 2026-10-16 from the audit's 17
 * crossings (cq-worker-services §2.6), Identity reading `tiers` (LX-08, merged after the audit)
 * and the write scan.
 *
 * To read what the scan sees:
 *
 *   pnpm --filter @polaris-key/worker exec vitest run test/tableCrossings.test.ts --reporter=verbose
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_SLUGS } from "../src/core/services.js";
import { TABLE_OWNERS } from "../src/db/owners.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

type RemovedBy = "permanent" | `P${number}-${number}`;

/** A service's use of a table another service owns: [service, table, removedBy]. */
const SEAMS: readonly (readonly [string, string, RemovedBy])[] = [
  // Identity issues, links and merges licences; the writes go through core/licensing.
  ["identity", "licenses", "permanent"],
  ["identity", "keys_index", "P0-20"],
  // LX-08: the sign-in's upgrade-only rank reads the tier.
  ["identity", "tiers", "P0-20"],
  // The portal's listings and download tokens (portal/repo.ts).
  ["identity", "release_metadata", "P0-23"],
  ["identity", "release_artifacts", "P0-23"],
  ["identity", "release_builds", "P0-23"],
  ["identity", "release_download_tokens", "P0-23"],
  // Release's link and resync write other owners' manifest-derived rows.
  ["release", "oidc_config", "P0-26"],
  ["release", "provisioning_config", "P0-26"],
  ["release", "edge_mint_config", "P0-26"],
  ["release", "edge_mint_approvals", "P0-26"],
  ["release", "product_schema", "P0-26"],
  ["release", "license_profiles", "P0-26"],
  // Distribution's commerce reads License's store grants.
  ["distribution", "license_store_grants", "P0-27"],
  // Update reads Release's pack tables inside the sanctioned update → release edge (packParts.ts).
  ["update", "release_pins", "permanent"],
  ["update", "release_holds", "permanent"],
  ["update", "release_pack_floors", "permanent"],
  ["update", "release_channel_policy", "permanent"],
];

/** Core or the console writing a table a service owns, by file under `src/`: [file, table, removedBy]. */
const WRITE_SEAMS: readonly (readonly [string, string, RemovedBy])[] = [
  ["console/handlers/feeds.ts", "dist_registry_feeds", "P0-19"],
  ["console/handlers/feeds.ts", "dist_registry_policy", "P0-19"],
  // Core's merge reads the override layer; Core's subject rows are the documented seam.
  ["core/accounts/accountOverrides.ts", "account_overrides", "permanent"],
  ["core/accounts/accountSubjects.ts", "account_product_subjects", "permanent"],
  ["core/accounts/accountSubjects.ts", "licenses", "P0-20"],
  // The product-delete and erase cascades.
  ["core/console/repo.ts", "account_overrides", "P0-19"],
  ["core/console/repo.ts", "account_product_grants", "P0-19"],
  ["core/console/repo.ts", "account_product_subject_aliases", "P0-19"],
  ["core/console/repo.ts", "account_product_subjects", "P0-19"],
  ["core/console/repo.ts", "account_terms_acceptances", "P0-19"],
  ["core/console/repo.ts", "dist_registry_owners", "P0-19"],
  ["core/console/repo.ts", "keys_index", "P0-20"],
  ["core/console/repo.ts", "library_entries", "P0-19"],
  ["core/console/repo.ts", "license_relinks", "P0-19"],
  ["core/console/repo.ts", "licenses", "P0-20"],
  ["core/console/repo.ts", "override_migration_report", "P0-19"],
  ["core/console/repo.ts", "portal_license_links", "P0-19"],
  ["core/console/repo.ts", "product_schema", "P0-26"],
  ["core/console/repo.ts", "profiles", "P0-26"],
  ["core/console/repo.ts", "storefront_daily", "P0-19"],
  ["core/console/repo.ts", "storefront_seen", "P0-19"],
  ["core/console/repo.ts", "tiers", "P0-20"],
  ["core/edgeMintApproval.ts", "edge_mint_approvals", "P0-26"],
  // core/licensing is the licences' home.
  ["core/licensing/grants.ts", "licenses", "permanent"],
  ["core/licensing/lifecycleWrites.ts", "licenses", "permanent"],
  ["core/ops/overrideMigration.ts", "account_overrides", "P0-49"],
  ["core/ops/overrideMigration.ts", "licenses", "P0-49"],
  ["core/ops/overrideMigration.ts", "override_migration", "P0-49"],
  ["core/ops/overrideMigration.ts", "override_migration_report", "P0-49"],
  ["core/ops/settingsBackfill.ts", "product_schema", "P0-26"],
  ["core/ops/settingsBackfill.ts", "profiles", "P0-26"],
  ["core/ops/settingsBackfill.ts", "tiers", "P0-26"],
  // The product registration and the licence tables' first writer.
  ["core/repo.ts", "edge_mint_approvals", "P0-26"],
  ["core/repo.ts", "edge_mint_config", "P0-26"],
  ["core/repo.ts", "keys_index", "P0-20"],
  ["core/repo.ts", "license_profiles", "P0-20"],
  ["core/repo.ts", "licenses", "P0-20"],
  ["core/repo.ts", "oidc_config", "P0-26"],
  ["core/repo.ts", "product_schema", "P0-26"],
  ["core/repo.ts", "profiles", "P0-26"],
  ["core/repo.ts", "provisioning_config", "P0-26"],
  ["core/repo.ts", "release_config", "P0-26"],
  ["core/repo.ts", "tiers", "P0-20"],
  ["core/settings/columns.ts", "portal_product_settings", "P0-19"],
  ["core/settingsClaims.ts", "product_schema", "P0-26"],
  // The erasure sweeps (SEC-WP-04).
  ["privacyResidue.ts", "account_tombstones", "permanent"],
  ["privacyResidue.ts", "license_relinks", "permanent"],
  ["privacyResidue.ts", "subject_events", "permanent"],
];

const OWNER = new Map<string, string>();
for (const [owner, tables] of Object.entries(TABLE_OWNERS))
  for (const t of tables) OWNER.set(t, owner);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The source without its comments; string and template literals (the SQL) are kept whole. */
function stripComments(source: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") out += source[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i++;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return out;
}

const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+([a-z_][a-z0-9_]*)\b/g;
const WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)\b/g;

interface Source {
  /** Path under `src/`. */
  file: string;
  /** `core`, `console` or a service slug. */
  area: string;
  sql: string;
}

function sources(): Source[] {
  return walkTs(SRC).map((full) => {
    const file = relative(SRC, full).split("\\").join("/");
    const area = file.startsWith("services/")
      ? file.split("/")[1]!
      : file.startsWith("console/")
        ? "console"
        : "core";
    return { file, area, sql: stripComments(readFileSync(full, "utf8")) };
  });
}

/** `service|table` → the files that touch another service's table. */
function crossings(all: Source[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const { file, area, sql } of all) {
    if (!(SERVICE_SLUGS as readonly string[]).includes(area)) continue;
    for (const m of sql.matchAll(TABLE_RE)) {
      const table = m[1]!;
      const owner = OWNER.get(table);
      if (!owner || owner === area || owner === "core") continue;
      const key = `${area}|${table}`;
      const files = found.get(key) ?? [];
      if (!files.includes(file)) files.push(file);
      found.set(key, files);
    }
  }
  return found;
}

/** `file|table`: Core or the console writing a table a service owns. */
function writeCrossings(all: Source[]): Set<string> {
  const found = new Set<string>();
  for (const { file, area, sql } of all) {
    if (area !== "core" && area !== "console") continue;
    for (const m of sql.matchAll(WRITE_RE)) {
      const owner = OWNER.get(m[1]!);
      if (owner && owner !== "core") found.add(`${file}|${m[1]}`);
    }
  }
  return found;
}

const ALL = sources();

describe("table ownership", () => {
  it("every owner is core or a service, and every table has one owner", () => {
    for (const owner of Object.keys(TABLE_OWNERS))
      expect(["core", ...SERVICE_SLUGS]).toContain(owner);
    const seen = new Set<string>();
    for (const tables of Object.values(TABLE_OWNERS))
      for (const t of tables) {
        expect(seen.has(t), `${t} has two owners`).toBe(false);
        seen.add(t);
      }
  });

  it("table crossings are only the declared seams, and every seam is still needed", () => {
    const now = crossings(ALL);
    const declared = new Set(SEAMS.map(([from, table]) => `${from}|${table}`));
    expect(
      [...now.keys()]
        .filter((k) => !declared.has(k))
        .map((k) => `${k} (${now.get(k)!.join(", ")})`),
      "a service uses another service's table: go through Core's hooks, or add a SEAMS row with the package that removes it",
    ).toEqual([]);
    expect(
      SEAMS.filter(([f, t]) => !now.has(`${f}|${t}`)).map(
        ([f, t]) => `${f}|${t}`,
      ),
      "no longer found: delete these SEAMS rows",
    ).toEqual([]);
    // The scan sees SQL at all.
    expect(now.has("identity|licenses")).toBe(true);
  });

  it("Core and the console write a service's table only from a declared file", () => {
    const now = writeCrossings(ALL);
    const declared = new Set(WRITE_SEAMS.map(([f, t]) => `${f}|${t}`));
    expect(
      [...now].filter((k) => !declared.has(k)),
      "Core or the console writes a service's table: move the write into the owner's directory, or add a WRITE_SEAMS row with the package that removes it",
    ).toEqual([]);
    expect(
      [...declared].filter((k) => !now.has(k)),
      "no longer found: delete these WRITE_SEAMS rows",
    ).toEqual([]);
  });

  it("each allow-list row names a package that removes it, or is permanent", () => {
    for (const [, , removedBy] of [...SEAMS, ...WRITE_SEAMS])
      expect(removedBy).toMatch(/^(permanent|P\d+-\d+)$/);
    for (const [, table] of [...SEAMS, ...WRITE_SEAMS])
      expect(OWNER.has(table), `${table} is in TABLE_OWNERS`).toBe(true);
  });

  it("reads SQL in strings, not in comments", () => {
    const source = [
      "// reads FROM licenses in a comment",
      "/* UPDATE tiers too */",
      'const q = "SELECT id FROM release_pins WHERE x = 1"; // FROM keys_index',
      "const t = `DELETE FROM release_holds WHERE url = 'https://x//y'`;",
    ].join("\n");
    const tables = [...stripComments(source).matchAll(TABLE_RE)].map(
      (m) => m[1],
    );
    expect(tables).toEqual(["release_pins", "release_holds"]);
  });
});
