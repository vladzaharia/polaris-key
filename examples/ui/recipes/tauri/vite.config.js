import { defineConfig } from "vite";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default defineConfig({
  // Relative URLs: the page works from any folder (ui:lint's static server) and from tauri://.
  base: "./",
  // Tauri's dev window loads a fixed port (tauri.conf.json devUrl).
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [repoRoot] } },
  resolve: { alias: elementsAlias },
});
