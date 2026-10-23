import { defineConfig } from "vite";
import { aliases, define, server } from "./vite.shared.mjs";

export default defineConfig({
  resolve: { alias: aliases, mainFields: ["module", "jsnext:main", "jsnext"] },
  define,
  server,
  build: { rollupOptions: { external: ["electron-updater", /^@napi-rs\//] } },
});
