import "../../tools/pin-test-env.mjs"; // TZ and locale pinned for the run
import { defineConfig } from "vitest/config";

import { fileURLToPath } from "node:url";
import { isolatedFiles, TEST_INCLUDE } from "./vitest.isolation.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const isolated = isolatedFiles(root);

// Default timeouts sized for a loaded machine or a slow CI runner, where vitest's 5 s / 10 s
// defaults trip on tests that take well under a second when idle. A test that bounds its own
// time (a CPU-budget test) asserts that bound itself; these only keep the runner from failing
// it first.
//
// Two projects (vitest.isolation.ts): `shared` runs without per-file isolation, so the modules
// load once per worker; `isolated` keeps a fresh module graph per file for the files that mock a
// module. PKEY_TEST_SHUFFLE=1 (the nightly run) also shuffles the order files run in, to surface
// state one file leaves for the next.
export default defineConfig({
  test: {
    environment: "node",
    // I-30: empty OIDC client caches per test (test/setup/oidcClient.ts).
    setupFiles: ["test/setup/oidcClient.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    ...(process.env.PKEY_TEST_SHUFFLE === "1"
      ? { sequence: { shuffle: { files: true, tests: false } } }
      : {}),
    projects: [
      {
        extends: true,
        test: {
          name: "shared",
          isolate: false,
          // One module graph per worker grows the heap; V8 left alone let a worker reach 2-4 GB
          // (measured). The cap keeps the peak near 1.3 GB at no cost in failures.
          execArgv: ["--max-old-space-size=1536"],
          include: TEST_INCLUDE,
          exclude: ["**/node_modules/**", ...isolated],
        },
      },
      {
        extends: true,
        test: {
          name: "isolated",
          isolate: true,
          include: isolated,
        },
      },
    ],
  },
});
