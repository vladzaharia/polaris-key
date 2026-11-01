import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";
import { aliases, define, server } from "./vite.shared.mjs";

// The SDK reads its own package.json next to its build. Bundled into main.cjs that file is gone,
// so the bundle is given the version in place of the read (only needed when the SDK is bundled).
const sdkVersion = {
  name: "pkey-sdk-version",
  transform(code, id) {
    if (!/(@polaris-key\/node|sdk-node)\/dist\/version\.js$/.test(id))
      return null;
    const { version } = JSON.parse(
      readFileSync(join(dirname(id), "../package.json"), "utf8"),
    );
    return code
      .replace(/import \{ createRequire \} from "node:module";\n/, "")
      .replace(/const require = createRequire\(import\.meta\.url\);\n/, "")
      .replace(
        /const pkg = require\("\.\.\/package\.json"\);/,
        `const pkg = { version: ${JSON.stringify(version)} };`,
      );
  },
};

export default defineConfig({
  plugins: [sdkVersion],
  resolve: { alias: aliases, mainFields: ["module", "jsnext:main", "jsnext"] },
  define,
  server,
  build: { rollupOptions: { external: ["electron-updater", /^@napi-rs\//] } },
});
