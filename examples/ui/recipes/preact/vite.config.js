import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default defineConfig({
  // Relative URLs: the page works from any folder, including ui:lint's static server.
  base: "./",
  plugins: [preact()],
  resolve: { alias: elementsAlias },
  server: { fs: { allow: [repoRoot] } },
});
