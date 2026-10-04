import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file, inside that file's isolated storage (per file, not per test,
// since vitest-pool-workers 0.13), so every test file sees a fully migrated D1 — the real
// thing, not better-sqlite3. `applyD1Migrations` skips migrations already applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
