import { defineConfig } from "vitest/config";

// Default timeouts sized for a loaded machine or a slow CI runner, where vitest's 5 s / 10 s
// defaults trip on tests that take well under a second when idle. A test that bounds its own
// time (a CPU-budget test) asserts that bound itself; these only keep the runner from failing
// it first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // I-30: empty OIDC client caches per test (test/setup/oidcClient.ts).
    setupFiles: ["test/setup/oidcClient.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
