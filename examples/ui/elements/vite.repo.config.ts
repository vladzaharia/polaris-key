// Inside the Polaris Key repo: the same page on the repo's build of @polaris-key/elements
// (packages/elements/dist; `pnpm --filter @polaris-key/elements build` first), with the repo's
// Vite. This folder has no node_modules, so the package is aliased to its build.
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dist = at("../../../packages/elements/dist/");

export default {
  resolve: {
    alias: [
      {
        find: /^@polaris-key\/elements\/(headless|contract)$/,
        replacement: `${dist}$1.js`,
      },
      { find: /^@polaris-key\/elements$/, replacement: `${dist}index.js` },
    ],
  },
  server: { fs: { allow: [at("../../../")] } },
  build: {
    rollupOptions: {
      input: {
        index: at("./index.html"),
        play: at("./play.html"),
        states: at("./states.html"),
      },
    },
  },
};
