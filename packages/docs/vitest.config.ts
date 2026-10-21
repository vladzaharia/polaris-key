import { defineConfig } from "vitest/config";

// The docs render the console's ui/ components with the docs' own React (astro.config.mjs dedupes
// it); the tests do the same, so the brand package's icons and the admin components share one.
export default defineConfig({
  resolve: { dedupe: ["react", "react-dom"] },
  test: { server: { deps: { inline: [/@polaris-key\/brand/] } } },
});
