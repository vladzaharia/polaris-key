// Copy the machine-readable artifacts into public/ so the gated site serves browsable copies:
//   packages/shared-manifest/schemas/v1/*  ->  public/schemas/v1/*   (canonical $id paths)
//   packages/worker/openapi/*              ->  public/openapi/*
//   @polaris-key/brand web/locker + social  ->  public/branding/locker/*  (favicons, touch icon,
//                                              the social card)
//
// Runs at the START of every build/dev, and the copies are gitignored — they are build
// products, so they cannot drift from their sources by construction (there is no committed
// copy to hand-edit). The sources remain the only editable files.

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const docsRoot = join(here, "..");
const packagesRoot = join(docsRoot, "..");

const COPIES = [
  {
    from: join(packagesRoot, "shared-manifest", "schemas", "v1"),
    to: join(docsRoot, "public", "schemas", "v1"),
    required: true,
  },
  {
    from: join(packagesRoot, "worker", "openapi"),
    to: join(docsRoot, "public", "openapi"),
    required: false, // arrives with the OpenAPI skeleton; tolerate absence until then
  },
];

// The Polaris Locker web identity, verbatim from the Locker kit through @polaris-key/brand
// (LK-00 §14.2: the docs chrome is Locker, served from key.plrs.im). Favicons, the touch icon and
// the social card. No site.webmanifest: the console already installs its identity on this origin,
// and one origin installs one identity.
const brandFile = (spec) => createRequire(import.meta.url).resolve(spec);
const BRAND_DIR = join(docsRoot, "public", "branding", "locker");
const BRAND_FILES = [
  "@polaris-key/brand/web/locker/favicon.svg",
  "@polaris-key/brand/web/locker/favicon.ico",
  "@polaris-key/brand/web/locker/apple-touch-icon.png",
  "@polaris-key/brand/social/locker/social-landscape-1200.png",
];

// The pre-LK-15 Polaris Key identity directory is gone.
rmSync(join(docsRoot, "public", "branding", "key"), {
  recursive: true,
  force: true,
});
rmSync(BRAND_DIR, { recursive: true, force: true });
mkdirSync(BRAND_DIR, { recursive: true });
for (const spec of BRAND_FILES) {
  const from = brandFile(spec);
  copyFileSync(from, join(BRAND_DIR, from.slice(from.lastIndexOf("/") + 1)));
}
console.log(
  `copy-artifacts: @polaris-key/brand (${BRAND_FILES.length} files) -> ${BRAND_DIR}`,
);

for (const copy of COPIES) {
  rmSync(copy.to, { recursive: true, force: true });
  if (!existsSync(copy.from)) {
    if (copy.required) {
      console.error(`copy-artifacts: missing required source ${copy.from}`);
      process.exit(1);
    }
    continue;
  }
  mkdirSync(copy.to, { recursive: true });
  cpSync(copy.from, copy.to, { recursive: true });
  console.log(`copy-artifacts: ${copy.from} -> ${copy.to}`);
}
