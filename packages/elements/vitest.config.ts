import { defineConfig } from "vitest/config";

// The elements under jsdom: every ui-matrix.json row drawn by its element, the DOM contract and
// the theme. The real-browser suite (renders, axe, keyboard, baselines) is vitest.browser.config.ts
// (`pnpm test:browser`); this config leaves test/browser/ out.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    exclude: ["test/browser/**", "**/node_modules/**"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
