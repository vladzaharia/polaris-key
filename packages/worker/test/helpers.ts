import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../src/db/sqlite.js";
import type { ServiceHooks } from "../src/core/hooks.js";
import type { ManifestIngest } from "../src/core/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

// Every migration, in filename order — so 0001_init and all later migrations reach the test DB.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

/** A fresh in-memory database with every migration applied (in filename order). */
export function makeTestDb(): SqliteDb {
  const sqlite = new Database(":memory:");
  // better-sqlite3's multi-statement DDL runner (bound to dodge a false-positive lint).
  const runScript = sqlite.exec.bind(sqlite);
  for (const sql of MIGRATIONS) runScript(sql);
  return new SqliteDb(sqlite);
}

/**
 * Descriptor hooks with every providing service off (`core/hooks.ts`). For a test that calls a
 * handler or a discovery fragment directly, without Core building the context: every accessor
 * answers `null`, exactly as it would for a product with Release and Distribution disabled.
 */
export const NO_HOOKS: ServiceHooks = {
  releaseCatalog: () => null,
  delivery: () => null,
  outletCapabilities: async () => null,
};

/** A manifest ingest that writes nothing for any service — for a test that builds a service
 *  context by hand (Core builds the real one from the registry, `manifestIngestFor`). */
export const NO_INGEST: ManifestIngest = () => ({ slugs: [], statements: [] });
