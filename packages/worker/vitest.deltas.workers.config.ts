import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";

/**
 * The workerd lane of the lazy-delta CONSUMER Worker (P4-17; `wrangler.deltas.toml`,
 * `src/deltasEntry.ts`). `vitest.workers.config.ts` boots the request Worker from wrangler.toml;
 * this boots real workerd from the consumer's own config, so its compatibility settings, its
 * module graph (the encoder's `zenc.wasm` as a compiled `WebAssembly.Module`, which only a
 * workerd lane can prove) and its queue handler are the ones that ship. `pnpm test:workerd` runs
 * both lanes.
 *
 * The queue, D1 and R2 bindings are per environment in wrangler.deltas.toml (account-specific),
 * so the lane declares local equivalents, as the request lane does. workerd enforces neither the
 * isolate's 128 MB nor `cpu_ms` (notes/S-08 §2.5), so the memory budget is asserted from the
 * encoder's own measurement.
 */
const ZSTD_WASM_DIST = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "node_modules/@polaris-key/zstd-wasm/dist",
);
const zstdWasmByPath: Plugin = {
  name: "polaris-key:zstd-wasm-by-path",
  enforce: "pre",
  resolveId(source, importer) {
    if (
      (source !== "./zdec.wasm" && source !== "./zenc.wasm") ||
      !importer?.includes("/zstd-wasm/")
    )
      return null;
    return resolvePath(ZSTD_WASM_DIST, source.slice(2));
  },
};

export default defineConfig(async () => {
  // The pool orders migrations by `parseInt` of the name's prefix, which reads a builder's
  // `00XX_` placeholder (the lead numbers new migrations at merge, CLAUDE.md) as 0 and applies it
  // FIRST, before the tables it alters exist. Filename order, which the Node lane
  // (`test/helpers.ts`), `scripts/record-deploy.mjs` and `LATEST_MIGRATION` already use, is the
  // same order for every numbered file and puts a placeholder last.
  const migrations = (await readD1Migrations("./migrations")).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  return {
    plugins: [
      zstdWasmByPath,
      cloudflareTest({
        wrangler: { configPath: "./wrangler.deltas.toml" },
        miniflare: {
          d1Databases: ["DB"],
          r2Buckets: ["BLOBS"],
          queueProducers: { DELTA_QUEUE: "pkey-deltas-test" },
          bindings: {
            TEST_MIGRATIONS: migrations,
            LAZY_DELTAS: "on",
          },
        },
      }),
    ],
    test: {
      include: ["test-workerd-deltas/**/*.test.ts"],
      setupFiles: ["./test-workerd-deltas/setup.ts"],
    },
  };
});
