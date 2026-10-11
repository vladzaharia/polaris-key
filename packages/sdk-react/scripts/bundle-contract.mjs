// After tsc: dist/kit/contract.js re-exports @polaris-key/elements/contract, a package that is not
// published yet. Bundle that module in its place, so the published @polaris-key/react imports only
// packages it depends on (ui-core, brand, client-core); the QR encoder and the stylesheet text
// come inline. Its declaration file is not reachable from the package's public types.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const external =
  /^(@polaris-key\/(ui-core|brand|client-core|protocol)(\/.*)?|react(\/.*)?)$/;

await build({
  root,
  configFile: false,
  logLevel: "warn",
  build: {
    outDir: join(root, "dist", "kit"),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry: join(root, "src", "kit", "contract.ts"),
      formats: ["es"],
      fileName: () => "contract.js",
    },
    rollupOptions: { external: (id) => external.test(id) },
  },
});
rmSync(join(root, "dist", "kit", "contract.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "contract.d.ts.map"), { force: true });
