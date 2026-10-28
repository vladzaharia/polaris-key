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

// The desktop chrome's rules and tokens (elements' desktopStyles.ts and desktopTokens.ts, UK-06) are the one part of the sheet a
// web page never draws. The kit's contract and the shared chunks take an empty stand-in for them,
// so the gate's entry does not carry them; desktopCss.js is the second build, with the real
// module, and the kit loads it on demand (kit/styles.ts `adoptDesktopStyles`).
const STAND_IN = {
  desktopStyles: "export const DESKTOP_CSS = '';",
  desktopTokens:
    "export const DESKTOP_VARIANTS = []; export const platformVars = () => ({}); export const platformTokenCss = () => '';",
};
const withoutDesktopRules = {
  name: "pkey-without-desktop-rules",
  enforce: "pre",
  resolveId(id) {
    const m = /(?:^|\/)(desktopStyles|desktopTokens)\.js$/.exec(id);
    return m ? `\0stand-in:${m[1]}` : null;
  },
  load(id) {
    return id.startsWith("\0stand-in:")
      ? STAND_IN[id.slice("\0stand-in:".length)]
      : null;
  },
};

const common = {
  root,
  configFile: false,
  logLevel: "warn",
};
const buildOf = (entry, plugins) => ({
  ...common,
  plugins,
  build: {
    outDir: join(root, "dist", "kit"),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    lib: {
      entry,
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { external: (id) => external.test(id) },
  },
});

// qr.js stays its own file: the kit imports it on demand, outside the gate's entry.
await build(
  buildOf(
    {
      contract: join(root, "src", "kit", "contract.ts"),
      qr: join(root, "src", "kit", "qr.ts"),
      contractForm: join(root, "src", "kit", "contractForm.ts"),
    },
    [withoutDesktopRules],
  ),
);
await build(
  buildOf({ desktopCss: join(root, "src", "kit", "desktopCss.ts") }, []),
);
// The Cloud Sync screens' layouts and rules: only the scoper and their own text, never the sheet.
await build(
  buildOf({ syncAssets: join(root, "src", "kit", "syncAssets.ts") }, []),
);
rmSync(join(root, "dist", "kit", "contract.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "qr.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "contractForm.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "desktopCss.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "syncAssets.js.map"), { force: true });
rmSync(join(root, "dist", "kit", "contract.d.ts.map"), { force: true });
