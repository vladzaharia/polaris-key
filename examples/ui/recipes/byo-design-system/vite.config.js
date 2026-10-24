import { defineConfig } from "vite";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default defineConfig({
  // Relative URLs: the page works from any folder, including ui:lint's static server.
  base: "./",
  resolve: { alias: elementsAlias },
  server: { fs: { allow: [repoRoot] } },
});
