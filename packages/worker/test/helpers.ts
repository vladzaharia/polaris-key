import Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDb } from "../src/db/sqlite.js";
import type { ServiceHooks } from "../src/core/hooks.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

// Every migration, in filename order — so 0001_init and all later migrations reach the test DB.
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

/** Where the serialized, migrated template databases are cached (one file per migration set). */
export const TEMPLATE_CACHE_DIR = join(tmpdir(), "pkey-test-db");

/** A fresh in-memory database with every migration applied (in filename order). */
export function migrateFresh(migrations: readonly string[]): Database.Database {
  const sqlite = new Database(":memory:");
  // better-sqlite3's multi-statement DDL runner (bound to dodge a false-positive lint).
  const runScript = sqlite.exec.bind(sqlite);
  for (const sql of migrations) runScript(sql);
  return sqlite;
}

/** The cache key: sha256 over the migration bytes (length-prefixed, so a boundary shift differs). */
export function templateKey(migrations: readonly string[]): string {
  const h = createHash("sha256");
  for (const sql of migrations) {
    const bytes = Buffer.from(sql, "utf8");
    h.update(`${bytes.length}:`).update(bytes);
  }
  return h.digest("hex");
}

/** True when the bytes open as a database that holds the migrated schema. */
function opens(bytes: Buffer): boolean {
  try {
    const probe = new Database(bytes);
    try {
      return (
        probe.prepare("SELECT count(*) AS n FROM sqlite_master").get() !==
        undefined
      );
    } finally {
      probe.close();
    }
  } catch {
    return false;
  }
}

/**
 * The serialized migrated database for `migrations`, from the cache in `dir`, built and cached on
 * a miss. A cache file that does not open is rebuilt. The file is written under a temp name and
 * renamed into place, so concurrent workers race safely (the last rename wins; every writer wrote
 * identical bytes).
 */
export function loadTemplate(
  migrations: readonly string[],
  dir: string = TEMPLATE_CACHE_DIR,
): Buffer {
  const file = join(dir, `${templateKey(migrations)}.sqlite`);
  try {
    const cached = readFileSync(file);
    if (opens(cached)) return cached;
  } catch {
    // missing or unreadable: build below
  }
  const built = migrateFresh(migrations);
  const bytes = built.serialize();
  built.close();
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  } catch {
    // a read-only tmpdir only costs the cache; the in-memory bytes still serve this process
  }
  return bytes;
}

let template: Buffer | undefined;

/** A fresh in-memory database with every migration applied: a clone of the cached template. */
export function makeTestDb(): SqliteDb {
  template ??= loadTemplate(MIGRATIONS);
  return new SqliteDb(new Database(template));
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
  licenseProvenance: () => null,
  storeProducts: () => null,
  githubPrToken: () => null,
};
