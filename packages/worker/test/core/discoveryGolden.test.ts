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
 * P2-08 made `dev` a built-in channel, so Update's `channels` list gained `dev` (a value in the
 * same list, no new key). P3-03 added Update's `endpoints.feed`, and P3-09 the four app-updater feed templates after it
 * (`winsparkle`, `velopack`, `appInstaller`, `zsync`): additive keys a client ignores.
 * I-01 removed Identity's `endpoints.authPoll` (S-16 §5.3: discovery response only, no SDK reads
 * it, owner decision D10); only its advertisement went then. The `/identity/auth/poll` route
 * itself is retired since (fix/followups-sweep-1006), which changes no discovery byte.
 * U-04 added the seventh service, Cloud Sync (plans/U-01.md §2.5, approved): each golden gained
 * `services.sync` after `identity`, `{"enabled":false}` when off; the everything product turns it
 * on and pins the fragment U-04 ships (every capability false, no endpoint until U-05, U-09 and
 * U-10 serve one). Additive, like `distribution` was.
 * I-09 (WIRE-CONTRACT-V4 §12.6, plans/I-09.md, approved) added Identity's account members to the
 * everything product's identity fragment: `account` and `keyEntryLimit` after `configured`, and
 * the `attach`, `subject`, `signout` and `accountPortal` endpoints last. Additive keys a client
 * ignores; every Identity-off fragment is unchanged.
 * U-05.15 (plans/U-05-slices.md, WIRE-CONTRACT-V4 §13.5) turned Cloud Sync's `settings` on and named
 * its `pull` (`<base>/sync`) and `push` (`<base>/sync/ops`) endpoints in the everything product's
 * fragment; `collections`, `saves` and `files` stay off. Additive.
 * U-09.7 (§13.5, G5d) turns `collections` true for a catalog that declares at least one collection
 * (`cloudSyncRecordsPush.test.ts` pins it); these goldens carry no catalog, so it stays off here.
 * CM-29 added the eighth service, Commerce (plans/CM-29.md §2): each golden gained
 * `services.commerce` after `sync`, `{"enabled":false}` when off; the everything product runs it
 * and pins the fragment (the two device endpoints, nothing about any store). Additive.
 * CC-02.1 added the ninth service, Cloud Connect (plans/CC-01-cloud-connect.md §2.9): each golden
 * gained `services.connect` after `commerce`, `{"enabled":false}` (it is off by default and no
 * product here turns it on). Additive.
 * I-08 (WIRE-CONTRACT-V4 §12.4, §12.5, plans/I-08.md, approved) added Identity's `issuer` after
 * `configured` (now always true: the platform sign-in needs no per-product IdP row) and the
 * `authorize` and `token` endpoints after `authDevicePoll`. Additive; every Identity-off fragment
 * is unchanged.
 * I-08b (WIRE-CONTRACT-V4 §12.5.1, plans/I-08.md D2, approved) added the four `choiceLicenses`,
 * `choiceDevices`, `choiceComplete` and `choiceCancel` endpoints after `token`. Additive keys a
 * client ignores; every Identity-off fragment is unchanged.
 * DISC-01 (WIRE-CONTRACT-V4 §5.7, plans/DISC-01.md, approved) added `core.portal` last in `core`, in
 * every document: `{"enabled":true,"activate":"<customer origin>/activate?product=<slug>"}` while
 * the product's portal is on (all three fixtures; the recording world has no `CUSTOMER_ORIGIN`),
 * `{"enabled":false}` while it is off. Additive, like `core.presentation`.
 * U-09.1 (WIRE-CONTRACT-V5 §13.5, plans/CC-01-cloud-sync.md §2.2, approved) added `services.sync.encryption` and
 * `endpoints.keyring` while the launch gate `launch.syncE2e` is on (the test env turns it on); the
 * everything product pins them. Additive.
 * CC-03.2 (plans/CC-01-cloud-connect.md §2.8, approved) added `core.endpoints.deviceKeys` (`<base>/devices/keys`)
 * after `report`, in every document. Additive.
 * I-13.7 (WIRE-CONTRACT-V5 §12.11.6) added Identity's `endpoints.nonce` (`<base>/identity/nonce`) after
 * `signout` while the `launch.identityExchange` gate is on (it is, in this suite's env), and the
 * `exchange` member only for a product that declares a platform sign-in kind (none here). Additive;
 * the transcripts `discovery-identity-exchange` and `exchange-gate-off` pin both.
 * I-13.9 added `endpoints.link` (`<base>/identity/link`) right after `nonce`, under the same gate.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";
import { loadProduct } from "../../src/core/products.js";
import { handleDiscovery } from "../../src/core/discovery.js";
import { SERVICES } from "../../src/mount.js";
import { setServices } from "../../src/core/products/store.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { TEST_ROOT } from "../paths.js";

const GOLDEN = JSON.parse(
  readFileSync(join(TEST_ROOT, "fixtures", "discovery-golden.json"), "utf8"),
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
    '{"license":{"enabled":true},"config":{"enabled":true},"release":{"enabled":true},"distribution":{"enabled":true},"update":{"enabled":true},"identity":{"enabled":true},"sync":{"enabled":true},"commerce":{"enabled":true}}',
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
