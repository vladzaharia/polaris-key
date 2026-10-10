/**
 * LX-07: the affected-licence report for the offline grace clamp (S-19 §7.6, decision 7), run on
 * a PRODUCTION-SHAPED COPY (RUNBOOK "Offline grace clamp"), offline, with no Worker, no KEK and
 * no network.
 *
 *   pnpm --filter @polaris-key/worker grace-clamp:report -- --sql prod.sql [--product djdl] [--now <epoch>] [--out dir]
 *   pnpm --filter @polaris-key/worker grace-clamp:report -- --sqlite prod.sqlite [--product djdl] [--now <epoch>] [--out dir]
 *
 * `--sql` is a `wrangler d1 export` dump (the owner takes it; agents never run wrangler against a
 * remote), `--sqlite` a database file. Either is loaded into MEMORY, so the copy on disk is never
 * opened for writing. `graceClampReport` (`src/core/licensing/graceClamp.ts`) then lists, per product, every
 * usable licence whose offline window the clamp shortens for a document issued at `--now`
 * (default: the current time), with the product's `licensing.clampGraceToExpiry` state resolved
 * through the real settings registry. The tool asserts the report changed nothing (SQLite's
 * `total_changes()`) and prints the totals and the report; with `--out` it writes `report.json`
 * and `report.csv` there. The report carries licence ids, tiers and counts only: no name, email
 * or key.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SqliteDb } from "../src/db/sqlite.js";
import {
  graceClampReport,
  graceClampReportCsv,
  type GraceClampReport,
} from "../src/core/licensing/graceClamp.js";
import { SETTINGS } from "../src/mount.js";

export interface CopyReport {
  report: GraceClampReport;
  csv: string;
  /** Rows the report changed in the in-memory copy: always 0 (checked). */
  changes: number;
}

/** Load the copy into memory and build the report. Throws when the report wrote anything. */
export async function reportOnCopy(input: {
  sql?: string;
  sqliteBytes?: Buffer;
  product?: string;
  now: number;
}): Promise<CopyReport> {
  let sqlite: Database.Database;
  if (input.sqliteBytes) {
    sqlite = new Database(input.sqliteBytes);
  } else if (input.sql !== undefined) {
    sqlite = new Database(":memory:");
    sqlite.exec(input.sql);
  } else {
    throw new Error("give the copy as --sql or --sqlite");
  }
  try {
    const hasSettings = sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_settings'",
      )
      .get();
    if (!hasSettings)
      throw new Error(
        "the copy has no product_settings table: it predates the settings store (migration 0086), so it cannot say which products opted out",
      );
    const changes = () =>
      Number(
        (sqlite.prepare("SELECT total_changes() AS n").get() as { n: number })
          .n,
      );
    const before = changes();
    const report = await graceClampReport(
      { env: {}, db: new SqliteDb(sqlite), registry: SETTINGS },
      {
        now: input.now,
        ...(input.product !== undefined ? { product: input.product } : {}),
      },
    );
    const changed = changes() - before;
    if (changed !== 0)
      throw new Error(
        `the report changed ${changed} row(s); it must change none`,
      );
    return { report, csv: graceClampReportCsv(report), changes: changed };
  } finally {
    sqlite.close();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const sqlPath = arg("--sql");
  const sqlitePath = arg("--sqlite");
  const out = arg("--out");
  const nowArg = arg("--now");
  const now =
    nowArg !== undefined ? Number(nowArg) : Math.floor(Date.now() / 1000);
  if (!sqlPath === !sqlitePath || !Number.isSafeInteger(now)) {
    console.error(
      "usage: grace-clamp:report -- (--sql <dump.sql> | --sqlite <db.sqlite>) [--product <slug>] [--now <epoch seconds>] [--out <dir>]",
    );
    process.exit(2);
  }
  const { report, csv } = await reportOnCopy({
    ...(sqlPath ? { sql: readFileSync(sqlPath, "utf8") } : {}),
    ...(sqlitePath ? { sqliteBytes: readFileSync(sqlitePath) } : {}),
    ...(arg("--product") ? { product: arg("--product")! } : {}),
    now,
  });
  console.log(JSON.stringify(report, null, 2));
  const { totals } = report;
  console.error(
    `${totals.licences} licence(s) on ${totals.products} product(s) expire inside their offline window (${totals.authorizedDevices} authorised device(s)); ${totals.clampedLicences} of them are on products whose clamp is on and get a shorter window. Nothing was written.`,
  );
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(
      join(out, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(join(out, "report.csv"), csv);
    console.error(`wrote report.json and report.csv to ${out}`);
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
