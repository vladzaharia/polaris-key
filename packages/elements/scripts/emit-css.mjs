// After tsc: write dist/styles.css (the shared stylesheet React re-exports, UI-KITS.md §3.2) from
// the built module, and copy brand's fonts beside it (dist/fonts/, loaded by src/fonts.ts).
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

const { stylesCss } = await import(join(dist, "styles.js"));
writeFileSync(
  join(dist, "styles.css"),
  `/* @polaris-key/elements: the shared kit stylesheet (generated at build from src/styles.ts). */\n${stylesCss()}`,
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
