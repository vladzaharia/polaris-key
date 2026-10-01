/**
 * The Update service: the `entitled` access mode (P2.T3, D-13) and the per-arch appcast
 * (P2.T4).
 *
 * ── WHAT THE ENTITLED HALF CLOSES ───────────────────────────────────────────────────────────
 *
 * R3 recorded it plainly: a stable-only licence could fetch `/<p>/beta/appcast.xml` and the beta
 * DMG behind it, because the release surface authenticated at most the DEVICE and never
 * consulted the grant. `licensed` asks "is there a usable licence"; `entitled` asks "is this
 * licence allowed THIS channel, at THIS version" — the same question `GET /<p>/license/document`
 * already asks, over the same rows, through the same merge (`core/entitledAccess.ts`).
 *
 * It is opt-in per product and `public` stays the default, so the first assertions here are the
 * ones that matter most: an existing product's feed is unchanged.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  mkReq,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import type { Product } from "../src/core/products.js";
import { loadProduct } from "../src/core/products.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { handleActivate } from "../src/services/license/activation.js";
// P2b-04: the feed reads Distribution's delivery access and the downloads are Distribution's,
// so both go through the one entry point that drives them the way the router does
// (`releaseSurface.ts`: the downloads at their permanent alias paths).
import {
  handleReleaseSurface as handleUpdate,
  handleReleaseSurface as handleRelease,
  seedDeliveryAccess,
} from "./releaseSurface.js";
import { updateParams } from "../src/services/update/eligibility.js";
import { handleUpdateRoutes } from "../src/services/update/routes.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";

const SLUG = "djdl";

function asset(name: string, id: number, size = 1024): ReleaseAsset {
  return {
    id,
    name,
    size,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/acme/djdl/releases/download/v1.2.3/${name}`,
  };
}

function release(over: Partial<Release> = {}): Release {
  return {
    tag_name: "v1.2.3",
    name: "1.2.3",
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.2.3",
    prerelease: false,
    draft: false,
    assets: [],
    ...over,
  };
}

/** Both architectures, plus their sidecar signatures. */
const DUAL_ARCH = release({
  assets: [
    asset("djdl-1.2.3-arm64.dmg", 21, 4096),
    asset("djdl-1.2.3-x86_64.dmg", 22, 5120),
  ],
});

const BETA = release({
  tag_name: "v2.0.0-beta.1",
  prerelease: true,
  published_at: "2026-02-01T00:00:00Z",
  assets: [asset("djdl-2.0.0-beta.1-arm64.dmg", 31, 4096)],
});

async function seedCfg(
  db: SqliteDb,
  over: Record<string, unknown> = {},
): Promise<void> {
  const row = {
    product: SLUG,
    gh_owner: "acme",
    gh_repo: "djdl",
    gh_installation_id: 42,
    channel_workflow: null,
    beta_branch: "main",
    manual_channels_json: null,
    binary_name: "djdl",
    install_template: null,
    // No Sparkle key: `requireSparkleSignature` is opted out below so the feed renders unsigned.
    sparkle_ed25519_pub: null,
    summary_marker: "pkey:summary",
    artifact_policy_json: null as string | null,
    metadata_access: "public",
    artifacts_access: "public",
    // The opt-out is OPERATOR policy, so it lives in `operator_policy_json` (P0-01).
    operator_policy_json: JSON.stringify({
      requireSparkleSignature: false,
    }) as string | null,
    ...over,
  };
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access, operator_policy_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.product,
    row.gh_owner,
    row.gh_repo,
    row.gh_installation_id,
    row.channel_workflow,
    row.beta_branch,
    row.manual_channels_json,
    row.binary_name,
    row.install_template,
    row.sparkle_ed25519_pub,
    row.summary_marker,
    row.artifact_policy_json,
    row.metadata_access,
    row.artifacts_access,
    row.operator_policy_json,
  );  await seedDeliveryAccess(db, row.product, row.artifacts_access);
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

function stubFetch(releases: Release[]): FetchImpl {
  return async (input) => {
    const url = String(input);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/releases?per_page"))
      return new Response(JSON.stringify(releases), { status: 200 });
    const tag = url.match(/\/releases\/tags\/([^?]+)/)?.[1];
    if (tag) {
      const hit = releases.find((r) => r.tag_name === decodeURIComponent(tag));
      return hit
        ? new Response(JSON.stringify(hit), { status: 200 })
        : new Response("no", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  };
}

function feedReq(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers }) as unknown as Request;
}

/** Activate a licence and return the device token it mints. */
async function deviceToken(
  env: Env,
  db: SqliteDb,
  product: Product,
  opts: Parameters<typeof seedLicenseWithKey>[2] = {},
): Promise<string> {
  const { key } = await seedLicenseWithKey(db, SLUG, opts);
  const res = await handleActivate(
    mkReq("POST", {
      authorization: `Bearer ${key}`,
      "x-pkey-device": "dev-1",
    }),
    env,
    db,
    product,
    NOW,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function fixture(
  cfg: Record<string, unknown> = {},
): Promise<{ db: SqliteDb; env: Env; product: Product }> {
  const db = makeTestDb();
  const env = envFor();
  await seedProduct(db, SLUG);
  await seedCfg(db, cfg);
  const product = (await loadProduct(env, db, SLUG))!;
  return { db, env, product };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// T2.3 — the entitled access mode
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("public is still the default", () => {
  it("serves the beta appcast to an anonymous caller for an unchanged product", async () => {
    const { db, env, product } = await fixture();
    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/beta/appcast.xml"),
      env,
      db,
      product,
      "channelAppcast",
      { channel: "beta", arch: "arm64" },
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("djdl-2.0.0-beta.1-arm64.dmg");
  });
});

describe("entitled feeds (D-13) — the R3 gap", () => {
  it("refuses a stable-only licence the beta appcast", async () => {
    // The appcast is governed by `artifacts_access`, not `metadata_access`: it EMBEDS the
    // enclosure URL, so gating the feed under the informational column would advertise a
    // download the artifact column refuses. `accessModeFor` has drawn that line since before the
    // split; the test below pins it explicitly.
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product);

    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/beta/appcast.xml", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      "channelAppcast",
      { channel: "beta", arch: "arm64" },
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(403);
    // The nested wire-v3 error shape, as `GET /<p>/license/document` uses (§R4).
    expect(await res.json()).toEqual({
      error: { code: "channel_not_allowed" },
    });
  });

  it("serves the same feed to a beta-entitled licence", async () => {
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product, { channels: ["beta"] });

    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/beta/appcast.xml", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      "channelAppcast",
      { channel: "beta", arch: "arm64" },
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("djdl-2.0.0-beta.1-arm64.dmg");
  });

  it("takes the entitlement from the TIER as readily as from the licence", async () => {
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    await seedTier(db, SLUG, "insider", { channels: ["beta"] });
    const token = await deviceToken(env, db, product, { tierId: "insider" });

    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/beta/appcast.xml", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      "channelAppcast",
      { channel: "beta", arch: "arm64" },
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(200);
  });

  it("never refuses the stable channel — it is the floor every grant holds", async () => {
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product);
    for (const params of [{ arch: "arm64" as const }, { channel: "stable" }]) {
      const res = await handleUpdate(
        feedReq("https://key.plrs.im/djdl/update/appcast.xml", {
          authorization: `Bearer ${token}`,
        }),
        env,
        db,
        product,
        "appcast",
        params,
        stubFetch([DUAL_ARCH]),
      );
      expect(res.status).toBe(200);
    }
  });

  it("resolves ?channel= on the version surface (B4)", async () => {
    // Both SDKs send `?channel=` on `/update/version`; the server used to discard it and
    // answer for stable regardless. `updateParams` is the unit that changed — compose it
    // with the same request, exactly as the route does.
    const { db, env, product } = await fixture();
    const versionFor = async (url: string): Promise<Response> =>
      handleUpdate(
        feedReq(url),
        env,
        db,
        product,
        "version",
        updateParams(feedReq(url), "version"),
        stubFetch([BETA, DUAL_ARCH]),
      );

    const beta = await versionFor(
      "https://key.plrs.im/djdl/update/version?channel=beta",
    );
    expect(beta.status).toBe(200);
    expect(await beta.json()).toMatchObject({ version: "2.0.0-beta.1" });
    // A moving selector answers with the short cache, exactly like its appcast.
    expect(beta.headers.get("cache-control")).toContain("max-age=120");

    const stable = await versionFor("https://key.plrs.im/djdl/update/version");
    expect(await stable.json()).toMatchObject({ version: "1.2.3" });

    // A well-formed but unknown channel 404s like an unknown channel appcast.
    const bogus = await versionFor(
      "https://key.plrs.im/djdl/update/version?channel=bogus",
    );
    expect(bogus.status).toBe(404);
  });

  it("404s a ?channel= value the path form could not express (B4)", async () => {
    // The query spelling is held to the router's path-channel alphabet, refused at the
    // ROUTE (null → the registry's 404) before any resolution or network work.
    const { db, env, product } = await fixture();
    const res = await handleUpdateRoutes({
      req: feedReq("https://key.plrs.im/djdl/update/version?channel=Beta%2F1"),
      env,
      db,
      product,
      rest: ["version"],
      now: NOW,
      viaAlias: false,
    } as unknown as Parameters<typeof handleUpdateRoutes>[0]);
    expect(res).toBeNull();
  });

  it("holds the entitled gate on a query channel exactly as on a path channel (B4)", async () => {
    const { db, env, product } = await fixture({ metadata_access: "entitled" });
    const token = await deviceToken(env, db, product, { channels: ["stable"] });
    const url = "https://key.plrs.im/djdl/update/version?channel=beta";
    const res = await handleUpdate(
      feedReq(url, { authorization: `Bearer ${token}` }),
      env,
      db,
      product,
      "version",
      updateParams(feedReq(url), "version"),
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: { code: "channel_not_allowed" },
    });
  });

  it("requires a token at all, in the v3 shape", async () => {
    const { db, env, product } = await fixture({ metadata_access: "entitled" });
    for (const headers of [{}, { authorization: "Bearer pkeyt_nope" }] as Array<
      Record<string, string>
    >) {
      const res = await handleUpdate(
        feedReq("https://key.plrs.im/djdl/update/version", headers),
        env,
        db,
        product,
        "version",
        {},
        stubFetch([DUAL_ARCH]),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized" } });
    }
  });

  it("refuses a stable-only licence the beta ARTIFACT, not just the feed", async () => {
    // The other half of the R3 gap. Refusing the feed while serving the DMG it would have named
    // is not a control — the enclosure URL is guessable, and an updater that has ever seen one
    // has it. Both surfaces run the same `enforceReleaseAccess`, over the same selector.
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product);

    const res = await handleRelease(
      feedReq(
        "https://key.plrs.im/djdl/release/dl/beta/djdl-2.0.0-beta.1-arm64.dmg",
        { authorization: `Bearer ${token}` },
      ),
      env,
      db,
      product,
      "dmg",
      { version: "beta", arch: "arm64" },
      stubFetch([BETA, DUAL_ARCH]),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "channel_not_allowed" },
    });
  });

  it("blocks a pinned artifact outside the licence's version window", async () => {
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product, { minVersion: "2.0.0" });

    const res = await handleRelease(
      feedReq("https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      "dmg",
      { version: "1.2.3", arch: "arm64" },
      stubFetch([DUAL_ARCH]),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "version_blocked" },
      // The window the caller MAY run in, intersected with the product's compat range.
      allowedRange: { min: "2.0.0", max: "99.0.0" },
    });
  });

  it("allows the same artifact once the window admits it", async () => {
    const { db, env, product } = await fixture({
      artifacts_access: "entitled",
    });
    const token = await deviceToken(env, db, product, { minVersion: "1.0.0" });

    const res = await handleRelease(
      feedReq("https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg", {
        authorization: `Bearer ${token}`,
      }),
      env,
      db,
      product,
      "dmg",
      { version: "1.2.3", arch: "arm64" },
      stubFetch([DUAL_ARCH]),
    );
    // 404 rather than 200 only because the fetch stub does not serve asset BYTES; the point is
    // that the access gate let the request through to the surface.
    expect(res.status).not.toBe(403);
  });

  it("governs metadata and artifacts independently", async () => {
    // A product can publish an open changelog and `/version` while gating the feed and the
    // downloads behind entitlement — the two columns exist precisely so the operator does not
    // have to choose. `accessModeFor` routes version/changelog/install to `metadata` and
    // appcast/dl to `artifacts`.
    const { db, env, product } = await fixture({
      metadata_access: "public",
      artifacts_access: "entitled",
    });
    const anonymousVersion = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/version"),
      env,
      db,
      product,
      "version",
      {},
      stubFetch([DUAL_ARCH]),
    );
    expect(anonymousVersion.status).toBe(200);

    const anonymousFeed = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/appcast.xml"),
      env,
      db,
      product,
      "appcast",
      { arch: "arm64" },
      stubFetch([DUAL_ARCH]),
    );
    expect(anonymousFeed.status).toBe(401);

    const artifact = await handleRelease(
      feedReq("https://key.plrs.im/djdl/release/dl/1.2.3/djdl-arm64.dmg"),
      env,
      db,
      product,
      "dmg",
      { version: "1.2.3", arch: "arm64" },
      stubFetch([DUAL_ARCH]),
    );
    expect(artifact.status).toBe(401);
  });

  it("never caches an entitled response — the edge cache is public-only", async () => {
    // The gateway only consults the Cache API when the effective mode is `public`, so a hit can
    // never bypass `enforceReleaseAccess`. Asserted through the response's own headers: an
    // entitled 403 is `no-store`, not a cacheable body.
    const { db, env, product } = await fixture({ metadata_access: "entitled" });
    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/version"),
      env,
      db,
      product,
      "version",
      {},
      stubFetch([DUAL_ARCH]),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// T2.4 — per-arch appcasts
// ═══════════════════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════════════════
// P0-04 — `staging` is the legacy alias of `beta` (WIRE-CONTRACT-V3 §5.1 rule 6)
// ═══════════════════════════════════════════════════════════════════════════════════════════

const RC = release({
  tag_name: "v2.0.0-rc.1",
  prerelease: true,
  published_at: "2026-03-01T00:00:00Z",
  assets: [asset("djdl-2.0.0-rc.1-arm64.dmg", 41, 4096)],
});

const MANUAL_STAGING = JSON.stringify([
  { name: "staging", regex: "v\\d+\\.\\d+\\.\\d+-rc\\.\\d+" },
]);

describe("the staging alias (P0-04)", () => {
  const channelFeed = async (
    f: { db: SqliteDb; env: Env; product: Product },
    channel: string,
    headers: Record<string, string> = {},
    releases: Release[] = [BETA, DUAL_ARCH],
  ): Promise<Response> => {
    const url = `https://key.plrs.im/djdl/update/${channel}/appcast.xml`;
    return handleUpdate(
      feedReq(url, headers),
      f.env,
      f.db,
      f.product,
      "channelAppcast",
      { channel, arch: "arm64" },
      stubFetch(releases),
    );
  };

  it("/update/staging/appcast.xml resolves like beta", async () => {
    const f = await fixture();
    const staging = await channelFeed(f, "staging");
    expect(staging.status).toBe(200);
    const body = await staging.text();
    expect(body).toContain("djdl-2.0.0-beta.1-arm64.dmg");
    // The requested spelling is kept in the enclosure segment (D8).
    expect(body).toContain("/staging/");
  });

  it("a declared manual staging channel wins over the alias", async () => {
    const f = await fixture({ manual_channels_json: MANUAL_STAGING });
    const res = await channelFeed(f, "staging", {}, [RC, BETA, DUAL_ARCH]);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("djdl-2.0.0-rc.1-arm64.dmg");
    expect(body).not.toContain("djdl-2.0.0-beta.1-arm64.dmg");
  });

  it("under entitled, staging and beta grants cover each other", async () => {
    const f = await fixture({ artifacts_access: "entitled" });
    const legacy = await deviceToken(f.env, f.db, f.product, {
      id: "lic_legacy",
      channels: ["stable", "staging"],
    });
    expect(
      (await channelFeed(f, "beta", { authorization: `Bearer ${legacy}` }))
        .status,
    ).toBe(200);

    const f2 = await fixture({ artifacts_access: "entitled" });
    const modern = await deviceToken(f2.env, f2.db, f2.product, {
      id: "lic_modern",
      channels: ["stable", "beta"],
    });
    expect(
      (await channelFeed(f2, "staging", { authorization: `Bearer ${modern}` }))
        .status,
    ).toBe(200);
  });

  it("a beta grant is refused a manual staging channel", async () => {
    const f = await fixture({
      artifacts_access: "entitled",
      manual_channels_json: MANUAL_STAGING,
    });
    const token = await deviceToken(f.env, f.db, f.product, {
      channels: ["stable", "beta"],
    });
    const res = await channelFeed(
      f,
      "staging",
      { authorization: `Bearer ${token}` },
      [RC, BETA, DUAL_ARCH],
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "channel_not_allowed" },
    });
  });
});

describe("per-arch appcasts", () => {
  /** Render the feed the way the sub-router would: the same `updateParams`, the same handler,
   *  with the GitHub client stubbed out (the router has no injection point, by design). */
  async function feed(url: string): Promise<string> {
    const { db, env, product } = await fixture();
    const req = feedReq(url);
    const res = await handleUpdate(
      req,
      env,
      db,
      product,
      "appcast",
      updateParams(req, "appcast"),
      stubFetch([DUAL_ARCH]),
    );
    expect(res.status).toBe(200);
    return res.text();
  }

  it("parses `?arch=` identically on the canonical route and its permanent alias", () => {
    // Both spellings reach the same `updateParams` because the core router rewrites the alias
    // into the canonical segments before dispatch (`router.test.ts` pins that half).
    for (const path of ["/djdl/update/appcast.xml", "/djdl/appcast.xml"]) {
      const req = feedReq(`https://key.plrs.im${path}?arch=x86_64`);
      expect(updateParams(req, "appcast")).toEqual({ arch: "x86_64" });
    }
    expect(
      updateParams(
        feedReq("https://key.plrs.im/djdl/update/beta/appcast.xml"),
        "channelAppcast",
        "beta",
      ),
    ).toEqual({ channel: "beta", arch: "arm64" });
    // `/version` takes no arch: there is one answer per selector, whatever the machine.
    expect(
      updateParams(
        feedReq("https://key.plrs.im/djdl/update/version?arch=x86_64"),
        "version",
      ),
    ).toEqual({});
  });

  it("defaults to arm64 when no arch is requested", async () => {
    // Every shipped `SUFeedURL` points at the unparameterised feed, so its meaning cannot change.
    const xml = await feed("https://key.plrs.im/djdl/update/appcast.xml");
    expect(xml).toContain("djdl-1.2.3-arm64.dmg");
    expect(xml).not.toContain("x86_64");
  });

  it("serves the x86_64 DMG for ?arch=x86_64", async () => {
    const xml = await feed(
      "https://key.plrs.im/djdl/update/appcast.xml?arch=x86_64",
    );
    expect(xml).toContain("djdl-1.2.3-x86_64.dmg");
    expect(xml).not.toContain("arm64");
    // The enclosure points at the canonical download route, per-arch.
    expect(xml).toContain(
      'url="https://key.plrs.im/djdl/release/dl/1.2.3/djdl-1.2.3-x86_64.dmg"',
    );
    // …and carries that build's own length, not the arm64 one's.
    expect(xml).toContain('length="5120"');
  });

  it("accepts the arch aliases an updater might send", async () => {
    expect(
      await feed("https://key.plrs.im/djdl/update/appcast.xml?arch=amd64"),
    ).toContain("x86_64");
    expect(
      await feed("https://key.plrs.im/djdl/update/appcast.xml?arch=aarch64"),
    ).toContain("arm64");
  });

  it("falls back to the default rather than 404ing on an unknown arch", async () => {
    // The parameter is a hint about the machine, not a resource identifier: a client this build
    // has never heard of should still be offered the mainstream build.
    const xml = await feed(
      "https://key.plrs.im/djdl/update/appcast.xml?arch=sparc",
    );
    expect(xml).toContain("djdl-1.2.3-arm64.dmg");
  });

  it("keys the edge cache on arch, so the two feeds cannot collide", async () => {
    const { db, env, product } = await fixture();
    const store = new Map<string, Response>();
    const cache = {
      match: async (r: Request) => store.get(String((r as Request).url)),
      put: async (r: Request, res: Response) => {
        store.set(String((r as Request).url), res);
      },
    };
    (globalThis as { caches?: unknown }).caches = { default: cache };
    try {
      for (const arch of ["arm64", "x86_64"] as const) {
        await handleUpdate(
          feedReq(`https://key.plrs.im/djdl/update/appcast.xml?arch=${arch}`),
          env,
          db,
          product,
          "appcast",
          { arch },
          stubFetch([DUAL_ARCH]),
        );
      }
      expect(store.size).toBe(2);
      expect(
        [...store.keys()].filter((k) => k.includes("a=x86_64")),
      ).toHaveLength(1);
      expect(
        [...store.keys()].filter((k) => k.includes("a=arm64")),
      ).toHaveLength(1);
    } finally {
      delete (globalThis as { caches?: unknown }).caches;
    }
  });
});

describe("release notes in the feed", () => {
  it("wires the curated changelog summary into the item description", async () => {
    const { db, env, product } = await fixture();
    const withNotes = release({
      assets: DUAL_ARCH.assets,
      body: "<!-- pkey:summary -->\nFaster exports and a fix for the queue.\n<!-- /pkey:summary -->",
    });
    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/appcast.xml"),
      env,
      db,
      product,
      "appcast",
      { arch: "arm64" },
      stubFetch([withNotes]),
    );
    const xml = await res.text();
    expect(xml).toContain(
      "<description><![CDATA[Faster exports and a fix for the queue.]]></description>",
    );
  });

  it("renders a `]]><script>` payload inert (R6-13 / R9-08)", async () => {
    const { db, env, product } = await fixture();
    const hostile = release({
      assets: DUAL_ARCH.assets,
      body:
        "<!-- pkey:summary -->\n" +
        "ok]]></description><enclosure url='https://evil/x.dmg'/><description><![CDATA[<script>alert(1)</script>\n" +
        "<!-- /pkey:summary -->",
    });
    const res = await handleUpdate(
      feedReq("https://key.plrs.im/djdl/update/appcast.xml"),
      env,
      db,
      product,
      "appcast",
      { arch: "arm64" },
      stubFetch([hostile]),
    );
    const xml = await res.text();
    expect(xml).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="utf-8"?>
      <rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">
        <channel>
          <title>djdl</title>
          <link>https://key.plrs.im</link>
          <item>
            <title>djdl 1.2.3</title>
            <pubDate>Fri, 02 Jan 2026 03:04:05 GMT</pubDate>
            <sparkle:version>1.2.3</sparkle:version>
            <sparkle:shortVersionString>1.2.3</sparkle:shortVersionString>
            <description><![CDATA[ok]]&gt;&lt;/description&gt;&lt;enclosure url=&apos;https://evil/x.dmg&apos;/&gt;&lt;description&gt;&lt;![CDATA[&lt;script&gt;alert(1)&lt;/script&gt;]]></description>
            <enclosure url="https://key.plrs.im/djdl/release/dl/1.2.3/djdl-1.2.3-arm64.dmg" type="application/octet-stream" length="4096" />
          </item>
        </channel>
      </rss>
      "
    `);
    // The two properties the snapshot is there to guard, stated outright:
    expect(xml.match(/<enclosure /g)).toHaveLength(1);
    expect(xml).not.toContain("<script>");
    // Note what the snapshot shows: on THIS path the payload never reaches the CDATA
    // neutraliser, because `proseToHtml` has already escaped the `>` that would have closed the
    // section. The neutraliser is the layer beneath, for any future producer that hands
    // `renderItem` real HTML; it is exercised directly in `attack/R9-injection.test.ts`.
  });

  it("wires the operator-declared minimumSystemVersion, and only a well-formed one", async () => {
    for (const [declared, expected] of [
      [
        "13.0",
        "<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>",
      ],
      // Anything Sparkle could not parse would silently make every update ineligible, so a
      // malformed value is dropped rather than rendered.
      ["thirteen", null],
      ["13.0; rm -rf /", null],
    ] as Array<[string, string | null]>) {
      const { db, env, product } = await fixture({
        operator_policy_json: JSON.stringify({
          requireSparkleSignature: false,
          minimumSystemVersion: declared,
        }),
      });
      const res = await handleUpdate(
        feedReq("https://key.plrs.im/djdl/update/appcast.xml"),
        env,
        db,
        product,
        "appcast",
        { arch: "arm64" },
        stubFetch([DUAL_ARCH]),
      );
      const xml = await res.text();
      if (expected) expect(xml).toContain(expected);
      else expect(xml).not.toContain("minimumSystemVersion");
    }
  });
});
