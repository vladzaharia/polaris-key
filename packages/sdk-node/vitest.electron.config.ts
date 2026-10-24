import { defineConfig } from "vitest/config";

// The real-runtime kit harness (test/electron-e2e/): it launches the built Electron sample, so it
// is not part of `pnpm test` (the default config's include never matches `*.e2e.ts`). Run it with
// `pnpm test:electron`, through the machine's heavy-job wrapper where there is one. One worker:
// every window opens on the same display.
export default defineConfig({
  test: {
    include: ["test/electron-e2e/**/*.e2e.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
  },
});
