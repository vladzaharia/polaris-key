import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

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
 * The runtime is current: `@cloudflare/vitest-pool-workers` 0.13+ runs on vitest 4, and the
 * pinned release ships a workerd whose latest supported compatibility date is past
 * wrangler.toml's 2026-04-07, so the lane runs at the production date with no fallback.
 * `runtime.test.ts` still asserts WebCrypto Ed25519 (the feature wrangler.toml names as its
 * reason for that date) directly, so a regression there fails the lane. The pin stops at the
 * last pool release on stable miniflare 4 (0.19.1); 0.20+ moves to miniflare 5 alpha.
 *
 * Broad coverage stays in the Node lane, which is far faster. Both are additive; neither
 * replaces the other.
 */
/**
 * `@polaris-key/zstd-wasm`'s workerd entry imports `./zdec.wasm` as a `WebAssembly.Module` (P4-02
 * decodes files indexes with it at ingest). Vite follows the workspace symlink to the package's
 * real directory, outside this package's root, and names the file `/@fs/<path>`, a spelling the
 * pool's module fallback cannot load ("No such module"). This resolves that one import through
 * the symlink under this package's `node_modules` instead, which the pool serves as
 * `CompiledWasm` — the same `WebAssembly.Module` wrangler bundles for a deploy.
 */
const ZSTD_WASM_DIST = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules/@polaris-key/zstd-wasm/dist",
);
const zstdWasmByPath: Plugin = {
  name: "polaris-key:zstd-wasm-by-path",
  enforce: "pre",
  resolveId(source, importer) {
    if (source !== "./zdec.wasm" || !importer?.includes("/zstd-wasm/"))
      return null;
    return resolvePath(ZSTD_WASM_DIST, "zdec.wasm");
  },
};

export default defineConfig(async () => {
  // Read in Node (workerd has no filesystem) and hand the SQL to the isolate as a binding.
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      zstdWasmByPath,
      cloudflareTest({
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
      }),
    ],
    test: {
      // `test/**` belongs to the Node lane. Keeping the workerd lane in its own directory
      // means neither config needs an `exclude` that could silently swallow a whole file.
      include: ["test-workerd/**/*.test.ts"],
      setupFiles: ["./test-workerd/setup.ts"],
    },
  };
});
