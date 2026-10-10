import { defineConfig } from "vitest/config";

// Default timeouts sized for a loaded machine or a slow CI runner, where vitest's 5 s / 10 s
// defaults trip on tests that take well under a second when idle. A test that bounds its own
// time asserts that bound itself; these only keep the runner from failing it first.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
