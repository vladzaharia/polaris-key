// After tsc: write dist/styles.css (the shared stylesheet React re-exports, UI-KITS.md §3.2) from
// the built module, and copy brand's fonts beside it (dist/fonts/, loaded by src/fonts.ts).
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// The shipped module carries the rules without their comments and blank lines: the sheet is
// inlined in every kit's bundle (React's, the CDN module), and prose is what gzip does worst on
// (the React kit's size budget counts it). The source keeps them.
const stylesJs = join(dist, "styles.js");
const built = readFileSync(stylesJs, "utf8");
const open = built.indexOf("const KIT_CSS = String.raw `");
const close = built.indexOf("`;", open);
if (open < 0 || close < 0)
  throw new Error("emit-css: KIT_CSS not found in dist/styles.js");
const head = built.slice(0, open);
const rules = built
  .slice(open, close)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/[ \t]+$/gm, "")
  .replace(/\n{2,}/g, "\n");
writeFileSync(stylesJs, head + rules + built.slice(close));

// The light-DOM form: every selector anchored to `.pk-root`, all of it in `@layer polaris-key`
// (src/contract.ts). The elements adopt the shadow form from JS and never load this file.
const { lightDomCss } = await import(
  pathToFileURL(join(dist, "contract.js")).href
);
writeFileSync(
  join(dist, "styles.css"),
  `/* @polaris-key/elements: the shared kit stylesheet (generated at build from src/styles.ts). */\n${lightDomCss()}`,
);

const require = createRequire(import.meta.url);
const brandFonts = join(
  dirname(require.resolve("@polaris-key/brand/package.json")),
  "fonts",
);
mkdirSync(join(dist, "fonts"), { recursive: true });
for (const f of readdirSync(brandFonts))
  if (/\.(woff2|css|txt)$/.test(f))
    copyFileSync(join(brandFonts, f), join(dist, "fonts", f));
