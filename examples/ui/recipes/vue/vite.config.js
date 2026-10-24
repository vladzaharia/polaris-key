import vue from "@vitejs/plugin-vue";

import { elementsAlias, repoRoot } from "../alias.mjs";

export default {
  base: "./",
  plugins: [
    // pk-* are custom elements, not Vue components: leave them to the browser.
    vue({
      template: {
        compilerOptions: { isCustomElement: (t) => t.startsWith("pk-") },
      },
    }),
  ],
  resolve: { alias: elementsAlias },
  server: { fs: { allow: [repoRoot] } },
};
