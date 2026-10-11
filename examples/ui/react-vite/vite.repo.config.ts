// Inside the Polaris Key repo: the same app on the repo's build of @polaris-key/react
// (packages/sdk-react/dist; `pnpm --filter @polaris-key/react build` first) and its React, with
// the repo's Vite. It imports nothing from node_modules, because this folder has none: Vite
// transforms the TSX itself (no Fast Refresh; the published config adds @vitejs/plugin-react).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const sdk = at("../../../packages/sdk-react/");
const dist = `${sdk}dist/`;
const pkg = JSON.parse(readFileSync(at("./package.json"), "utf8")) as {
  version: string;
};

export default ({ mode }: { mode: string }) => {
  const live = mode === "live" || process.argv.includes("--live");
  return {
    define: {
      __POLARIS_LIVE__: JSON.stringify(live),
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    resolve: {
      alias: [
        // Longest first: each subpath to its file in dist/.
        {
          find: /^@polaris-key\/react\/fonts\.css$/,
          replacement: `${dist}fonts/fonts.css`,
        },
        {
          find: /^@polaris-key\/react\/styles\.css$/,
          replacement: `${dist}styles.css`,
        },
        {
          find: /^@polaris-key\/react\/(core|desktop|browser|kit)$/,
          replacement: `${dist}$1/index.js`,
        },
        { find: /^@polaris-key\/react$/, replacement: `${dist}index.js` },
        // One React: the one the SDK's build resolves.
        { find: "react-dom", replacement: `${sdk}node_modules/react-dom` },
        { find: "react", replacement: `${sdk}node_modules/react` },
      ],
    },
    server: { fs: { allow: [at("../../../")] } },
  };
};
