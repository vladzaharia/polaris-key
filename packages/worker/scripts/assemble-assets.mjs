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

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, "..");
const adminDist = join(workerRoot, "..", "admin", "dist");
const docsDist = join(workerRoot, "..", "docs", "dist");
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
