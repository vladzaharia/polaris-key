// Inside the Polaris Key repo this folder has no installed @polaris-key packages, so the three
// builds point them at the repo's own builds (`pnpm --filter @polaris-key/node --filter
// @polaris-key/react build` first). Outside the repo (npm install) nothing is aliased.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(p, import.meta.url));
const node = at("../../../packages/sdk-node/");
const react = at("../../../packages/sdk-react/");
const inRepo =
  existsSync(`${node}dist/index.js`) &&
  !existsSync(at("./node_modules/@polaris-key"));

export const version = JSON.parse(
  readFileSync(at("./package.json"), "utf8"),
).version;

export const aliases = inRepo
  ? [
      {
        find: /^@polaris-key\/node\/electron\/preload$/,
        replacement: `${node}dist/electron/preload.js`,
      },
      {
        find: /^@polaris-key\/node\/electron$/,
        replacement: `${node}dist/electron/index.js`,
      },
      {
        find: /^@polaris-key\/node\/update\/drivers\/electron-updater$/,
        replacement: `${node}dist/update/drivers/electronUpdater.js`,
      },
      { find: /^@polaris-key\/node$/, replacement: `${node}dist/index.js` },
      {
        find: /^@polaris-key\/react\/fonts\.css$/,
        replacement: `${react}dist/fonts/fonts.css`,
      },
      {
        find: /^@polaris-key\/react\/styles\.css$/,
        replacement: `${react}dist/styles.css`,
      },
      {
        find: /^@polaris-key\/react\/(core|desktop|browser|kit)$/,
        replacement: `${react}dist/$1/index.js`,
      },
      { find: /^@polaris-key\/react$/, replacement: `${react}dist/index.js` },
      // One React: this folder's, for the SDK's build too.
      { find: "react-dom", replacement: at("./node_modules/react-dom") },
      { find: "react", replacement: at("./node_modules/react") },
    ]
  : [];

export const define = {
  __APP_VERSION__: JSON.stringify(version),
};
export const server = { fs: { allow: [at("../../../"), at("./")] } };
