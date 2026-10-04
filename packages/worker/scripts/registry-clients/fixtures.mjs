/**
 * Ecosystem fixtures for the registry-client harness (plans/F-01.md §6.8).
 *
 * Every `fixtures/<ecosystem>.mjs` exports `seedFixture(proxy, ctx)` and is run once, after the
 * migrations and the fixture owner (`seed.mjs`) and before `wrangler dev` starts, against the
 * same local state through wrangler's `getPlatformProxy`: real D1 and R2 bindings, so blobs carry
 * the SHA-256 checksum the byte routes require. `ctx` is `{ owner, now }`.
 *
 * The plan publishes the fixtures through `pkey release publish`; locally that path needs R2
 * S3 credentials for the upload tickets, which the harness does not have, so each fixture writes
 * the rows the package ingest writes (`services/release/packages/ingest.ts`) directly. What the
 * clients test, the feed's read side, is unchanged.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPlatformProxy } from "wrangler";
import { WORKER } from "./lib.mjs";

const DIR = join(WORKER, "scripts", "registry-clients", "fixtures");

export async function seedFixtures(persistTo, owner) {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".mjs"))
    .sort();
  if (files.length === 0) return;
  const proxy = await getPlatformProxy({
    configPath: join(WORKER, "wrangler.toml"),
    environment: "test",
    persist: { path: join(persistTo, "v3") },
  });
  try {
    const now = Math.floor(Date.now() / 1000);
    for (const f of files) {
      const mod = await import(pathToFileURL(join(DIR, f)).href);
      await mod.seedFixture(proxy.env, { owner, now });
      console.log(`fixture ${f}: seeded`);
    }
  } finally {
    await proxy.dispose();
  }
}
