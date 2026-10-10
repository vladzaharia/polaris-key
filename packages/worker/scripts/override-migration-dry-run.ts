/**
 * U-03: the licence-override migration's dry run on a PRODUCTION-SHAPED COPY (RUNBOOK "Licence
 * override migration", step 2), offline, with no Worker, no KEK and no network.
 *
 *   pnpm --filter @polaris-key/worker override-migration:dry-run -- --sql prod.sql [--product djdl] [--out dir]
 *   pnpm --filter @polaris-key/worker override-migration:dry-run -- --sqlite prod.sqlite [--product djdl] [--out dir]
 *
 * `--sql` is a `wrangler d1 export` dump (the owner takes it; agents never run wrangler against a
 * remote), `--sqlite` a database file. Either is loaded into MEMORY, so the copy on disk is never
 * opened for writing. The U-03 tables are created there when the copy predates them (`IF NOT
 * EXISTS`, exactly the migration's statements), then `dryRunOverrideMigration` runs: the same
 * planner the run uses. The tool asserts the dry run changed nothing (SQLite's `total_changes()`)
 * and prints the inventory; with `--out` it writes `inventory.json`, `report.json` and
 * `report.csv` there. Secret values are never in any of them: the planner never opens a sealed
 * value and lists secrets, and config keys the catalog flags `secret`, by name only.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteDb } from "../src/db/sqlite.js";
import {
  dryRunOverrideMigration,
  overrideMigrationReportCsv,
  type OverrideMigrationDryRun,
} from "../src/core/ops/overrideMigration.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");

export interface CopyDryRun {
  dryRun: OverrideMigrationDryRun;
  csv: string;
  /** Rows the dry run changed in the in-memory copy: always 0 (checked). */
  changes: number;
}

/** The U-03 migration's statements (every one `IF NOT EXISTS`). */
function u03Migration(): string {
  const file = readdirSync(MIGRATIONS).find((f) =>
    /_account_overrides\.sql$/.test(f),
  );
  if (!file) throw new Error("the account_overrides migration is missing");
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/**
 * Load the copy into memory, make sure the U-03 tables exist, and run the dry run. Throws when
 * the dry run wrote anything (it must not).
 */
export async function dryRunOnCopy(input: {
  sql?: string;
  sqliteBytes?: Buffer;
  product?: string;
  now: number;
}): Promise<CopyDryRun> {
  let sqlite: Database.Database;
  if (input.sqliteBytes) {
    sqlite = new Database(input.sqliteBytes);
  } else if (input.sql !== undefined) {
    sqlite = new Database(":memory:");
    sqlite.exec(input.sql);
  } else {
    throw new Error("give the copy as --sql or --sqlite");
  }
  sqlite.exec(u03Migration());
  const changes = () =>
    Number(
      (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number }).n,
    );
  const before = changes();
  const dryRun = await dryRunOverrideMigration(
    new SqliteDb(sqlite),
    input.now,
    input.product !== undefined ? { product: input.product } : {},
  );
  const changed = changes() - before;
  sqlite.close();
  if (changed !== 0)
    throw new Error(
      `the dry run changed ${changed} row(s); it must change none`,
    );
  const csv = overrideMigrationReportCsv(
    dryRun.report.map((r) => ({
      product: r.product,
      runId: "dry-run",
      licenseId: r.licenseId,
      outcome: r.outcome,
      subject: r.subject,
      buyerEmail: r.buyerEmail,
      keys: r.keys,
      values: r.values,
      createdAt: input.now,
      expiresAt: input.now,
    })),
  );
  return { dryRun, csv, changes: changed };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const sqlPath = arg("--sql");
  const sqlitePath = arg("--sqlite");
  const out = arg("--out");
  if (!sqlPath === !sqlitePath) {
    console.error(
      "usage: override-migration:dry-run -- (--sql <dump.sql> | --sqlite <db.sqlite>) [--product <slug>] [--out <dir>]",
    );
    process.exit(2);
  }
  const result = await dryRunOnCopy({
    ...(sqlPath ? { sql: readFileSync(sqlPath, "utf8") } : {}),
    ...(sqlitePath ? { sqliteBytes: readFileSync(sqlitePath) } : {}),
    ...(arg("--product") ? { product: arg("--product")! } : {}),
    now: Math.floor(Date.now() / 1000),
  });
  const { inventory, report } = result.dryRun;
  console.log(JSON.stringify(inventory, null, 2));
  console.error(
    `${report.length} licence(s): ${inventory.totals.owned} move to owners' account overrides, ${inventory.totals.dropped} dropped; ${report.filter((r) => r.outcome === "collapsed").length} collapse(s). Nothing was written.`,
  );
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "inventory.json"),
      `${JSON.stringify(inventory, null, 2)}\n`,
    );
    writeFileSync(
      join(out, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(join(out, "report.csv"), result.csv);
    console.error(`wrote inventory.json, report.json and report.csv to ${out}`);
  }
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
