import "../../tools/pin-test-env.mjs"; // TZ and locale pinned for the run
import { defineConfig } from "vitest/config";

// Default timeouts sized for a loaded machine or a slow CI runner, where vitest's 5 s / 10 s
// defaults trip on tests that take well under a second when idle. A test that bounds its own
// time (a CPU-budget test) asserts that bound itself; these only keep the runner from failing
// it first.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts", "scripts/*.test.ts"],
    // I-30: empty OIDC client caches per test (test/setup/oidcClient.ts).
    setupFiles: ["test/setup/oidcClient.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    // The nightly full run shuffles the order of the test files (PKEY_TEST_SHUFFLE=1, set by a
    // dispatch of ci.yml with its `shuffle` input), so a file that depends on another's side
    // effects fails there rather than by chance on a push. Every other run keeps the fixed order.
    sequence: {
      shuffle: { files: process.env.PKEY_TEST_SHUFFLE === "1", tests: false },
    },
  },
});
