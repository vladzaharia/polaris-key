import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default {
  preprocess: vitePreprocess(),
  // Components compile to Svelte components, not custom elements; pk-* stay the browser's.
  compilerOptions: { customElement: false },
};
