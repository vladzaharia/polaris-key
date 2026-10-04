/**
 * The discovery document is on the wire, and P0-09 moved the code that assembles it onto the
 * generated service table (`@polaris-key/manifest`'s `services.generated.ts`). That move must
 * not change a single byte a client reads: keys, key order and fragment shapes are the wire.
 *
 * So this suite compares the RAW response body for three fixture products against golden
 * documents captured from the pre-table build (`test/fixtures/discovery-golden.json`). The
 * fixture file is prettier-formatted JSON; re-serialising it with `JSON.stringify` preserves
 * key order and values exactly, so text equality here is byte equality with the original
 * compact output. If this fails, a wire shape moved — that is plan mode, not a fixture update.
 *
 * The sanctioned edits since capture: P2b-01 added the sixth service, so each golden gained
 * `services.distribution` (in table order, between `release` and `update`) and nothing else. A
 * new key under `services` is additive: clients ignore slugs they do not know (P0-08). P2b-04
 * filled Distribution's own fragment in (its brief: it advertises download, install, builds and
 * blobs, now that it serves every byte), inside the key P2b-01 added: `configured` and four
 * `endpoints`. Release's fragment keeps its keys — they name the permanent aliases — and gained
 * only additive members: P3-03's `endpoints.record` and `releaseKeyFingerprints`, then P4-02's
 * `packs: true` (plans/P4-01.md §6, decision 24: the CLI refuses to publish a pack without it),
 * then P4-13's `revocations: true` (plans/P4-13.md §6.3: the CLI refuses `revoke` without it),
 * P4-22's `chunks: true` between those two (plans/P4-10.md §6: the CLI publishes no `chunks`
 * without it), and P4-19's `delegations: true` last (plans/P4-19.md §6.3: `pkey release
 * delegate` requires it).
 * P3-03 added Update's `endpoints.feed`, and P3-09 the four app-updater feed templates after it
 * (`winsparkle`, `velopack`, `appInstaller`, `zsync`): additive keys a client ignores.
 * I-01 removed Identity's `endpoints.authPoll` (S-16 §5.3: discovery response only, no SDK reads
 * it, owner decision D10). The `/identity/auth/poll` route still answers until I-13 retires it;
 * only its advertisement went.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { loadProduct } from "../src/core/products.js";
import { handleDiscovery } from "../src/core/discovery.js";
import { SERVICES } from "../src/mount.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";

const GOLDEN = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "discovery-golden.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

async function discoveryText(env: Env, db: Db, slug: string): Promise<string> {
  const product = (await loadProduct(env, db, slug))!;
  const res = await handleDiscovery(
    new Request(
      `https://key.plrs.im/${slug}/.well-known/polaris.json`,
    ) as unknown as Request,
    env,
    db,
    product,
    SERVICES,
  );
  expect(res.status).toBe(200);
  return res.text();
}

/** Every service on, with the configuration rows Release and Identity publish from. */
async function seedEverything(db: Db, slug: string): Promise<void> {
  await seedProduct(db, slug);
  await db.run(
    "UPDATE products SET release_source = ? WHERE slug = ?",
    "github",
    slug,
  );
  await setServices(
    db,
    slug,
    '{"license":{"enabled":true},"config":{"enabled":true},"release":{"enabled":true},"distribution":{"enabled":true},"update":{"enabled":true},"identity":{"enabled":true}}',
    "manifest",
    NOW,
  );
  await db.run(
    `INSERT INTO oidc_config
       (product, provider, issuer, client_id, client_secret_secret, redirect_uris_json, group_role_map_json)
     VALUES (?,?,?,?,?,?,?)`,
    slug,
    "custom",
    "https://id.example",
    "client-123",
    "OIDC_SECRET",
    JSON.stringify([`https://key.plrs.im/${slug}/identity/auth/callback`]),
    "{}",
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    slug,
    "acme",
    slug,
    42,
    "release.yml",
    "main",
    "[]",
    slug,
    null,
    "SPARKLEPUB",
    "pkey:summary",
  );
}

describe("discovery document is byte-identical across the service-table move", () => {
  it("a product on the defaults (no services_json)", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["dflt"]);
    await seedProduct(db, "dflt");
    expect(await discoveryText(env, db, "dflt")).toBe(
      JSON.stringify(GOLDEN.defaults),
    );
  });

  it("a product running every service", async () => {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["full"]);
    await seedEverything(db, "full");
    expect(await discoveryText(env, db, "full")).toBe(
      JSON.stringify(GOLDEN.everything),
    );
  });

  it("a config-only product that also carries an unknown slug", async () => {
    // P0-08's passthrough: a slug this build does not know is kept in the column and is NOT
    // advertised. The document is the same as for a plain config-only product.
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), ["cfg"]);
    await seedProduct(db, "cfg");
    await setServices(
      db,
      "cfg",
      '{"license":{"enabled":false},"config":{"enabled":true},"release":{"enabled":false},"distribution":{"enabled":false},"update":{"enabled":false},"identity":{"enabled":false},"zeta":{"enabled":true},"registration":"open"}',
      "manifest",
      NOW,
    );
    expect(await discoveryText(env, db, "cfg")).toBe(
      JSON.stringify(GOLDEN.configOnly),
    );
  });
});
