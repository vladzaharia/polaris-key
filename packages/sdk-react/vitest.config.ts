import { defineConfig } from "vitest/config";

// The React SDK exercises both adapters and the components under jsdom (the parity
// suite drives @testing-library/react), so the environment is browser-shaped.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
