/**
 * P0-48 — table crossings, REPORT-ONLY.
 *
 * Rule 6's test (`boundaries.test.ts`) polices imports, not SQL: a service that never imports
 * another can still read and write the other's tables. This file scans the SQL in every file
 * under `src/services/<slug>/` (comments stripped; the upper-case `FROM`, `JOIN`, `INTO`, `UPDATE`
 * and `TABLE` keywords) against the logical ownership map, `TABLE_OWNERS` in the docs
 * generator (`packages/docs/scripts/gen-reference.mjs`, the data-model page's source), and
 * prints every table a service touches that another service owns. Core's tables are shared
 * substrate and not a crossing.
 *
 * `BASELINE` is the audit's list of the 17 crossings on 2026-10-07 (cq-worker-services §2.6).
 * Two of them are permanent seams: Identity writing `licenses` (declared in `core/data.ts`) and
 * Update reading Release's pack tables inside the sanctioned `update → release` edge. The report
 * marks any crossing outside the baseline as NEW and any baseline entry no longer found as GONE.
 * It does not fail on either: P0-18 moves the ownership map into the worker, adds the declared
 * seams and turns this into an enforced test whose allow-list must shrink to those two. On the
 * day it landed the report found 18: the 17, plus Identity reading `tiers` for the sign-in's
 * upgrade-only rank (`identity/oidc.ts`, LX-08, merged after the audit), shown as NEW.
 *
 * The default reporter hides a passing test's output; to read the report:
 *
 *   pnpm --filter @polaris-key/worker exec vitest run test/tableCrossings.test.ts --reporter=verbose
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain ESM script with no type declarations.
import { TABLE_OWNERS as OWNERS_UNTYPED } from "../../docs/scripts/gen-reference.mjs";
import { SERVICE_SLUGS } from "../src/core/services.js";

const TABLE_OWNERS = OWNERS_UNTYPED as Record<string, readonly string[]>;
const SERVICES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "services",
);

/** The 17 crossings of cq-worker-services §2.6 (2026-10-07): the service, and the table it uses. */
const BASELINE: readonly (readonly [from: string, table: string])[] = [
  // Identity → License (the first is the declared seam).
  ["identity", "licenses"],
  ["identity", "keys_index"],
  // Identity → Release: the portal's listings and download tokens (portal/repo.ts).
  ["identity", "release_metadata"],
  ["identity", "release_artifacts"],
  ["identity", "release_builds"],
  ["identity", "release_download_tokens"],
  // Release's link and resync → Identity, Config and License.
  ["release", "oidc_config"],
  ["release", "provisioning_config"],
  ["release", "edge_mint_config"],
  ["release", "edge_mint_approvals"],
  ["release", "product_schema"],
  ["release", "license_profiles"],
  // Distribution's commerce → License.
  ["distribution", "license_store_grants"],
  // Update → Release, inside the sanctioned edge but raw SQL (packParts.ts).
  ["update", "release_pins"],
  ["update", "release_holds"],
  ["update", "release_pack_floors"],
  ["update", "release_channel_policy"],
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

interface Crossing {
  from: string;
  owner: string;
  table: string;
  files: string[];
}

function crossings(): Crossing[] {
  const found = new Map<string, Crossing>();
  for (const from of readdirSync(SERVICES_ROOT)) {
    const dir = join(SERVICES_ROOT, from);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of walkTs(dir)) {
      const sql = stripComments(readFileSync(file, "utf8"));
      for (const m of sql.matchAll(TABLE_RE)) {
        const table = m[1]!;
        const owner = OWNER.get(table);
        if (!owner || owner === from || owner === "core") continue;
        const key = `${from}|${table}`;
        const c = found.get(key) ?? { from, owner, table, files: [] };
        const at = relative(SERVICES_ROOT, file).split("\\").join("/");
        if (!c.files.includes(at)) c.files.push(at);
        found.set(key, c);
      }
    }
  }
  return [...found.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.owner.localeCompare(b.owner) ||
      a.table.localeCompare(b.table),
  );
}

describe("table crossings (report-only, P0-48)", () => {
  it("reports every table a service uses that another service owns, against the audit's 17", () => {
    const now = crossings();
    const inBaseline = (c: Crossing) =>
      BASELINE.some(([from, table]) => from === c.from && table === c.table);
    const gone = BASELINE.filter(
      ([from, table]) => !now.some((c) => c.from === from && c.table === table),
    );
    const lines = [
      `Table crossings: ${now.length} found; the baseline (2026-10-07) lists ${BASELINE.length}.`,
      ...now.map(
        (c) =>
          `  ${inBaseline(c) ? "   " : "NEW"} ${c.from} → ${c.owner}.${c.table}  (${c.files.join(", ")})`,
      ),
      ...gone.map(([from, table]) => `  GONE ${from} → ${table}`),
    ];
    console.info(lines.join("\n"));

    // Report-only: crossings never fail this test, but the scan must be real.
    expect(BASELINE).toHaveLength(17);
    for (const [, table] of BASELINE)
      expect(OWNER.has(table), `${table} is in TABLE_OWNERS`).toBe(true);
    // Every service that owns a table is in the map under its slug.
    for (const owner of Object.keys(TABLE_OWNERS))
      expect(["core", ...SERVICE_SLUGS]).toContain(owner);
    // The declared seam is found, so the scanner sees SQL at all.
    expect(
      now.some((c) => c.from === "identity" && c.table === "licenses"),
    ).toBe(true);
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
