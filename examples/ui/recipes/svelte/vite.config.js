import { svelte } from "@sveltejs/vite-plugin-svelte";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default {
  base: "./",
  plugins: [svelte()],
  resolve: { alias: elementsAlias },
  server: { fs: { allow: [repoRoot] } },
};
