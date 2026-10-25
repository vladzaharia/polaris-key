import { defineConfig } from "vitest/config";

// The real-browser checks of the Worker's pages (Playwright; install a browser first:
// `pnpm --filter @polaris-key/conformance-browser exec playwright install chromium webkit`).
// Kept out of `pnpm test`: it needs the browsers. Run with `pnpm --filter @polaris-key/worker test:browser`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-browser/**/*.test.ts"],
    setupFiles: ["test/setup/oidcClient.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
