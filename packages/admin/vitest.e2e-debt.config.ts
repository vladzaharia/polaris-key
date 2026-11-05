import { defineConfig } from "vitest/config";

/**
 * The shrink-only debt ledgers of the split e2e suites (`pnpm --filter @polaris-key/admin
 * test:e2e:debt`). Every part of a split suite records which ledger entries it matched
 * (`e2e/parts.ts`); this reads them all back, once every part has run.
 */
export default defineConfig({
  test: { environment: "node", include: ["e2e-debt/**/*.test.ts"] },
});
