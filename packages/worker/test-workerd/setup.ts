import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per worker, outside the per-test isolated-storage stack, so every test file sees
// a fully migrated D1 — the real thing, not better-sqlite3.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
