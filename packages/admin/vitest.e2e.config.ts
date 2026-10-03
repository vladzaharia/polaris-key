import { defineConfig } from "vitest/config";

/**
 * The console's browser checks (`pnpm --filter @polaris-key/admin test:e2e`): the BUILT SPA in
 * real Chromium under the Worker's exact Content-Security-Policy. Not part of `pnpm test` (it
 * needs a Playwright browser); CI runs it in the browser job.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
