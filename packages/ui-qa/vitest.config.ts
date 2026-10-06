import { defineConfig } from "vitest/config";

// Node-only suites (no browser): the string lint, the kit source lints, the pixel diff, the report
// and the config. The browser suites are e2e/ (vitest.e2e.config.ts, `pnpm test:e2e`).
export default defineConfig({
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
