import { defineConfig } from "vitest/config";

// The React SDK exercises both adapters and the components under jsdom (the parity
// suite drives @testing-library/react), so the environment is browser-shaped.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    // Sized for a loaded machine or a slow CI runner (vitest's defaults are 5 s / 10 s).
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
