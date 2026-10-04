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
 * Then each ecosystem's fixture packages (`fixtures/*.mjs`, F-04 onwards): its feed rows
 * (`dist_registry_*`), its package releases as the ingest writes them, and their bytes in the
 * local bucket. They are written directly, not through `pkey release publish`: the publish path
 * hands out R2 temporary credentials for the S3 API, which local R2 does not serve.
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WORKER, argValue, wrangler } from "./lib.mjs";

/** The local blob bucket of `[env.test]` (wrangler.toml). */
export const FIXTURE_BUCKET = "polaris-key-blobs-registry-clients";
const FIXTURES = join(WORKER, "scripts", "registry-clients", "fixtures");

export const FIXTURE_OWNER = "registry-smoke";

export async function seed(persistTo) {
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
  // A product row and an active key row are what loadProductPublic needs; no route signs
  // anything, so the key columns hold inert placeholders and no product key is sealed.
  const sql = [
    `INSERT OR IGNORE INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
       default_max_offline_days, default_device_limit, admin_group, branding_json, release_source,
       created_at, modified_at)
     VALUES ('${FIXTURE_OWNER}', 'Registry smoke', 'registry-smoke-kid', 'AAAA', '0.0.0', '99.0.0',
       30, 5, NULL, NULL, NULL, ${now}, ${now});`,
    `UPDATE products SET services_json = '${JSON.stringify(services)}' WHERE slug = '${FIXTURE_OWNER}';`,
    // `loadProductPublic` needs an active key row. Its public half is inert and its sealed half a
    // placeholder: no registry route signs, so nothing ever opens it.
    `INSERT OR IGNORE INTO product_keys (product, kid, alg, public_b64url, enc_private_json, status, created_at)
     VALUES ('${FIXTURE_OWNER}', 'registry-smoke-kid', 'Ed25519', 'AAAA', '{}', 'active', ${now});`,
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
  await seedFixtures(persistTo, now);
}

/**
 * Every ecosystem's fixture packages (`fixtures/<ecosystem>.mjs`, F-04 onwards). Each module
 * exports `seedFixture(ctx)`, which writes its rows with `ctx.sql(text)` and its bytes with
 * `ctx.putObject(key, file)`, under `ctx.owner`, before the Worker starts.
 */
async function seedFixtures(persistTo, now) {
  let files = [];
  try {
    files = readdirSync(FIXTURES).filter((f) => f.endsWith(".mjs"));
  } catch {
    return;
  }
  const ctx = {
    persistTo,
    owner: FIXTURE_OWNER,
    now,
    sql(text) {
      const file = join(
        persistTo,
        `fixture-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`,
      );
      writeFileSync(file, text);
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
    },
    putObject(key, file) {
      wrangler([
        "r2",
        "object",
        "put",
        `${FIXTURE_BUCKET}/${key}`,
        "--file",
        file,
        "--local",
        "--env",
        "test",
        "--persist-to",
        persistTo,
      ]);
    },
  };
  for (const f of files.sort()) {
    const mod = await import(pathToFileURL(join(FIXTURES, f)).href);
    await mod.seedFixture(ctx);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const persistTo = argValue("--persist-to");
  if (!persistTo) {
    console.error("usage: seed.mjs --persist-to <dir>");
    process.exit(2);
  }
  await seed(persistTo);
}
