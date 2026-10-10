// After tsc: dist/styles.css is the elements' shared stylesheet in its light-DOM form, re-exported
// as `@polaris-key/react/styles.css` (UI-KITS.md §3.2). A server-rendered app imports it so its
// first paint is styled; in the browser the kit adopts the same rules itself. dist/fonts/ holds
// brand's faces as `@polaris-key/react/fonts.css`.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const elements = dirname(require.resolve("@polaris-key/elements/package.json"));
copyFileSync(
  join(elements, "dist", "styles.css"),
  join(root, "dist", "styles.css"),
);

// Rubik and the kit mono with their licences, as `@polaris-key/react/fonts.css` (a host that ships
// its own faces leaves it out; the kit then draws in the metric-matched system fallbacks).
const brandFonts = join(
  dirname(require.resolve("@polaris-key/brand/package.json")),
  "fonts",
);
mkdirSync(join(root, "dist", "fonts"), { recursive: true });
for (const f of readdirSync(brandFonts))
  if (/\.(woff2|css|txt)$/.test(f))
    copyFileSync(join(brandFonts, f), join(root, "dist", "fonts", f));
