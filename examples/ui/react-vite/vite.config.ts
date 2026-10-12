// The sample's Vite config. `--live` (or `--mode live`) swaps the Tidewater fixture for the real
// Worker in src/polaris.config.ts.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import pkg from "./package.json" with { type: "json" };

export default defineConfig(({ mode }) => {
  const live = mode === "live" || process.argv.includes("--live");
  return {
    plugins: [react()],
    define: {
      __POLARIS_LIVE__: JSON.stringify(live),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
  };
});
