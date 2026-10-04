#!/usr/bin/env node
/**
 * Seed the registry-client harness's local D1 (F-02, plans/F-01.md §6.8).
 *
 *   node scripts/registry-clients/seed.mjs --persist-to <dir>
 *
 * Applies every migration to the `--env test` database under `<dir>` and inserts the fixture
 * owner `registry-smoke` with Distribution on. Nothing here touches a deployed environment:
 * every wrangler call is `--local --env test`, and `[env.test]` has no routes.
 *
 * F-03 extends it: it creates the feed rows (`dist_registry_*`) and publishes the fixture
 * packages through the real `pkey release publish` path under a test trusted publisher, which
 * is what the ecosystem client matrices (F-04 to F-09) install from.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { argValue, wrangler } from "./lib.mjs";

export const FIXTURE_OWNER = "registry-smoke";

export function seed(persistTo) {
  wrangler([
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--env",
    "test",
    "--persist-to",
    persistTo,
  ]);
  const services = {
    license: { enabled: false },
    config: { enabled: false },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: false },
    identity: { enabled: false },
  };
  const now = Math.floor(Date.now() / 1000);
  // `loadProductPublic` needs the product row AND an active `product_keys` row (without one the
  // owner reads as unknown, so every feed route answered the not-found; found by F-05's clients).
  // No registry route signs anything, so both carry inert placeholders and nothing is sealed.
  const sql = [
    `INSERT OR IGNORE INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_device_limit, admin_group, branding_json, release_source,
       created_at, modified_at)
     VALUES ('${FIXTURE_OWNER}', 'Registry smoke', 'registry-smoke-kid', 'AAAA', '0.0.0', '99.0.0',
       30, 5, NULL, NULL, NULL, ${now}, ${now});`,
    `INSERT OR IGNORE INTO product_keys (product, kid, public_b64url, enc_private_json, status, created_at)
     VALUES ('${FIXTURE_OWNER}', 'registry-smoke-kid', 'AAAA', '{}', 'active', ${now});`,
    `UPDATE products SET services_json = '${JSON.stringify(services)}' WHERE slug = '${FIXTURE_OWNER}';`,
  ].join("\n");
  const file = join(persistTo, "registry-clients-seed.sql");
  writeFileSync(file, sql);
  wrangler([
    "d1",
    "execute",
    "DB",
    "--local",
    "--env",
    "test",
    "--persist-to",
    persistTo,
    "--file",
    file,
  ]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const persistTo = argValue("--persist-to");
  if (!persistTo) {
    console.error("usage: seed.mjs --persist-to <dir>");
    process.exit(2);
  }
  seed(persistTo);
}
