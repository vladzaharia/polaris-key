import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

/**
 * The **workerd** lane. `vitest.config.ts` (the Node lane) is structurally incapable of
 * catching the class of bug that produced R10-01: Ajv's `compile()` ran at request time,
 * workerd forbids code generation from strings outside the startup window, and so
 * `GET /<product>/config` would have returned 500 to every device on every poll — while all
 * of the Node-based tests passed. That bug was only ever caught by booting real workerd.
 *
 * This lane boots real workerd (via `@cloudflare/vitest-pool-workers` → miniflare) with the
 * worker's OWN `wrangler.toml`, so `compatibility_flags`, the bindings and the module graph
 * are the production ones and cannot drift from it. It is deliberately SMALL: only the paths
 * whose behaviour actually differs between Node and workerd — codegen, WebCrypto Ed25519, D1,
 * KV, Durable Objects — plus one real `/config` request end to end.
 *
 * KNOWN GAP, stated rather than hidden. `@cloudflare/vitest-pool-workers` only supports
 * vitest 3.2.x up to 0.12.21, which pins workerd 1.20260310.1; wrangler.toml asks for
 * compatibility_date 2026-04-07, so miniflare warns and falls back to 2026-03-10 on every
 * run. Two things bound the consequences: VERIFY-R10-01 §E3 showed request-phase codegen
 * throws at EVERY compat date from 2024-01-01 to 2026-04-07, so the canary does not depend on
 * the date; and `runtime.test.ts` asserts WebCrypto Ed25519 — the one feature wrangler.toml
 * names as its reason for 2026-04-07 — directly, so a regression there fails the lane rather
 * than passing silently. Closing the gap needs vitest 4 across the workspace.
 *
 * Broad coverage stays in the Node lane, which is far faster. Both are additive; neither
 * replaces the other.
 */
export default defineWorkersConfig(async () => {
  // Read in Node (workerd has no filesystem) and hand the SQL to the isolate as a binding.
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      // `test/**` belongs to the Node lane. Keeping the workerd lane in its own directory
      // means neither config needs an `exclude` that could silently swallow a whole file.
      include: ["test-workerd/**/*.test.ts"],
      setupFiles: ["./test-workerd/setup.ts"],
      poolOptions: {
        workers: {
          // Read the real deployment config. If this ever stops parsing, the lane fails —
          // which is the point: it is testing the thing that ships.
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            // Not declared at the top level of wrangler.toml (they are per-environment,
            // with account-specific ids), so the lane declares local equivalents.
            d1Databases: ["DB"],
            kvNamespaces: ["HOT"],
            // The blob store (P2-01): miniflare's local R2, so `test-workerd/blobs.test.ts`
            // exercises the real binding's checksum, range and conditional-put behaviour.
            r2Buckets: ["BLOBS"],
            bindings: {
              // A bytes host for the isolation smoke test. SELF requests to any other host
              // (every other test uses key.plrs.im) route exactly as without it.
              BLOB_ORIGIN: "https://dl.workerd.test",
              TEST_MIGRATIONS: migrations,
              // 32 zero bytes, base64 — the same constant the Node lane seeds with.
              PLATFORM_KEK: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
            },
          },
        },
      },
    },
  };
});
