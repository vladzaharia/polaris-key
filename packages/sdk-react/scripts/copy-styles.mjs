// After tsc: dist/styles.css is the elements' shared stylesheet in its light-DOM form, re-exported
// as `@polaris-key/react/styles.css` (UI-KITS.md §3.2). A server-rendered app imports it so its
// first paint is styled; in the browser the kit adopts the same rules itself.
import { copyFileSync } from "node:fs";
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
