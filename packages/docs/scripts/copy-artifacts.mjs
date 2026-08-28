// Copy the machine-readable artifacts into public/ so the gated site serves browsable copies:
//   packages/shared-manifest/schemas/v1/*  ->  public/schemas/v1/*   (canonical $id paths)
//   packages/worker/openapi/*              ->  public/openapi/*
//
// Runs at the START of every build/dev, and the copies are gitignored — they are build
// products, so they cannot drift from their sources by construction (there is no committed
// copy to hand-edit). The sources remain the only editable files.

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
