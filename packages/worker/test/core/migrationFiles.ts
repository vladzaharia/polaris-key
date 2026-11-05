// The migration directory and its files in order, shared by the migration replay tests.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { TEST_ROOT } from "../paths.js";

export const MIGRATIONS_DIR = join(TEST_ROOT, "..", "migrations");
export const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
