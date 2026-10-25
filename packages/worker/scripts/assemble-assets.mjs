// Assemble the worker's single static-assets root.
//
// wrangler allows exactly one `[assets] directory`, and this worker serves TWO built
// frontends from it: the admin/portal SPA (packages/admin/dist — served at `/manage` and `/`)
// and the gated docs site (packages/docs/dist — served at `/docs`). This script merges them
// into `packages/worker/assets/`, which `wrangler.toml` points at and `.gitignore` excludes.
//
//   node scripts/assemble-assets.mjs        (or: pnpm --filter @polaris-key/worker assemble)
//
// Ordering: run AFTER `pnpm build` (both frontends must exist). The docs dist is optional so
// `wrangler dev` keeps working before the docs site has ever been built — the worker then
// serves its placeholder shell at /docs — but a missing ADMIN dist is an error, because a
// worker with no SPA is never what anyone means to deploy.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, "..");
const adminDist = join(workerRoot, "..", "admin", "dist");
const docsDist = join(workerRoot, "..", "docs", "dist");
const elementsRoot = join(workerRoot, "..", "elements");
const out = join(workerRoot, "assets");

if (!existsSync(adminDist)) {
  console.error(
    `assemble-assets: missing ${adminDist} — run \`pnpm --filter @polaris-key/admin build\` first.`,
  );
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(adminDist, out, { recursive: true });

if (existsSync(docsDist)) {
  // The docs build already namespaces itself under /docs (Astro `base: "/docs"` puts the
  // pages in dist/… served at /docs/…), so it lands in a `docs/` subdirectory of the root.
  cpSync(docsDist, join(out, "docs"), { recursive: true });
  console.log(`assemble-assets: admin + docs -> ${out}`);
} else {
  console.warn(
    `assemble-assets: no docs dist at ${docsDist} — assembled admin only (the worker will serve its /docs placeholder). Run \`pnpm --filter @polaris-key/docs build\` to include the docs site.`,
  );
}

// The Elements CDN module (UK-04b): `/elements/<version>/pk.js` and its chunks, fonts and
// integrity.json, bundled by the package's own `bundle:cdn` straight into the assets root. The
// Worker route (src/core/elements.ts) serves it. Needs the package's `dist/` (`pnpm build`);
// absent, the route answers 404 and this says so rather than failing a `wrangler dev`.
if (existsSync(join(elementsRoot, "dist", "index.js"))) {
  const run = spawnSync(
    process.execPath,
    [join(elementsRoot, "scripts", "bundle-cdn.mjs"), join(out, "elements")],
    { stdio: "inherit" },
  );
  if (run.status !== 0) {
    console.error("assemble-assets: the Elements CDN bundle failed.");
    process.exit(1);
  }
} else {
  console.warn(
    `assemble-assets: no ${join(elementsRoot, "dist")} — /elements/* will answer 404. Run \`pnpm --filter @polaris-key/elements build\` first.`,
  );
}
