import { defineConfig } from "vitest/config";

// The browser suites: every rule against a seeded fixture, and the mockup boards clean. They need
// Chromium (`pnpm --filter @polaris-key/ui-qa exec playwright install chromium`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["e2e/**/*.e2e.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
