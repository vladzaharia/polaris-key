import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default defineConfig({
  // Relative URLs: the page works from any folder, including ui:lint's static server.
  base: "./",
  plugins: [solid()],
  resolve: { alias: elementsAlias },
  server: { fs: { allow: [repoRoot] } },
});
