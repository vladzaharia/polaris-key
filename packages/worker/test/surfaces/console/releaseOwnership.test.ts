/**
 * Operator ownership of release settings across a manifest resync (P0-01).
 *
 * `resyncRepo` used to rewrite the compat window, both access modes and the whole
 * `artifact_policy_json` blob on every `.pkey/` push. `entitled` has no manifest spelling, so any
 * push silently downgraded an entitled product to the manifest's mode (default `public`), and the
 * operator-only keys that lived inside `artifact_policy_json` were erased with the blob.
 *
 * The fix follows `services_source`: two ownership markers (`products.compat_source`,
 * `release_config.access_source`) that a console write of `update.metadataAccess` or
 * `release.compatWindow` claims and resync's own UPDATE honours,
 * plus a separate `release_config.operator_policy_json` that no manifest path writes at all.
 * Since P2b-04 the ARTIFACTS mode is Distribution's delivery access, with the same rule on its
 * own marker (`dist_access.source`, claimed by writing `distribution.access`).
 *
 * Every case here drives the REAL path: `linkRepo` registers the product from a stubbed GitHub,
 * the console API (`handleAdmin`) makes the operator's edit through the generic settings routes
 * (ST-05b), and `resyncRepo` re-reads a changed `.pkey/` from the same stub.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import type { Release } from "../../../src/services/release/github.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { loadProduct } from "../../../src/core/products.js";
import { getProduct } from "../../../src/core/products/store.js";
import { listAudit } from "../../../src/core/audit.js";
import { linkRepo } from "../../../src/services/release/linkRepo.js";
import { resyncRepo } from "../../../src/services/release/resync.js";
import { ingestFor } from "../../../src/core/ingest/pipeline.js";
import { SERVICES } from "../../../src/mount.js";
import { getReleaseConfig } from "../../../src/services/release/index.js";
// P2b-04: the appcast reads Distribution's delivery access, so it is driven the way the router
// drives it (`releaseSurface.ts`).
import { handleReleaseSurface as handleUpdate } from "../../releaseSurface.js";
import { withDefaultHead } from "../../githubHead.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";
import { TEST_ROOT as HERE } from "../../paths.js";

const SLUG = "acme";
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const KEY = (key: string) => `/api/products/${SLUG}/settings/${key}`;
const ACCESS = "distribution.access";
const METADATA = "update.metadataAccess";
const WINDOW = "release.compatWindow";
const POLICY = "update.operatorPolicy";

const BACKFILL_SQL = readFileSync(
  join(HERE, "..", "migrations", "0022_d_operator_policy_backfill.sql"),
  "utf8",
);

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_JSON = JSON.stringify({
  schemaVersion: 1,
  entries: [
    {
      key: "run.concurrency",
      kind: "config",
      category: "run",
      label: "Concurrency",
      description: "",
      schema: { type: "integer", minimum: 1 },
    },
  ],
});

function productJson(
  compatMin: string,
  compatMax = "9.0.0",
  modules?: Record<string, { enabled: boolean }>,
): string {
  return JSON.stringify({
    slug: SLUG,
    name: "Acme",
    compatMin,
    compatMax,
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    tiers: [],
    provisioning: [],
    ...(modules ? { modules } : {}),
  });
}

/** A product running the release chain, so Distribution's ingest runs (P2b-04). */
const CHAIN_MODULES = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
};
const chainProduct = (): string => productJson("1.0.0", "9.0.0", CHAIN_MODULES);

/** No Sparkle key: the appcast case opts the product out of signatures as OPERATOR policy. */
function releaseJson(
  access: { metadata?: string; artifacts?: string },
  artifactPolicy: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    release: {
      ghOwner: "acme-org",
      ghRepo: "acme-app",
      binaryName: "acme",
      betaBranch: "main",
      summaryMarker: "pkey:summary",
      access,
      ...(Object.keys(artifactPolicy).length > 0 ? { artifactPolicy } : {}),
    },
  });
}

const RELEASE: Release = {
  tag_name: "v1.2.3",
  name: "1.2.3",
  body: null,
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/acme-org/acme-app/releases/tag/v1.2.3",
  prerelease: false,
  draft: false,
  assets: [
    {
      id: 21,
      name: "acme-1.2.3-arm64.dmg",
      size: 4096,
      content_type: "application/octet-stream",
      browser_download_url:
        "https://github.com/acme-org/acme-app/releases/download/v1.2.3/acme-1.2.3-arm64.dmg",
    },
  ],
};

/** GitHub, stubbed: installation discovery, the token exchange, `.pkey/` contents, releases. */
function github(files: Record<string, string>): FetchImpl {
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`)) {
          const content = Buffer.from(body, "utf8").toString("base64");
          return new Response(JSON.stringify({ content, encoding: "base64" }), {
            status: 200,
          });
        }
      }
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response(JSON.stringify([RELEASE]), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

function pkey(product: string, release: string): FetchImpl {
  return github({
    ".pkey/schema.json": SCHEMA_JSON,
    ".pkey/product.json": product,
    ".pkey/release.json": release,
  });
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  env.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  return env;
}

/** A linked product, as `.pkey/` first described it, plus a console session to edit it with. */
async function linked(
  product = productJson("1.0.0"),
  release = releaseJson({ metadata: "public", artifacts: "public" }),
) {
  const db = makeTestDb();
  const env = envFor();
  // With Core's ingest pipeline, as the console and the webhook run it: Distribution's
  // `manifestIngest` writes the manifest's delivery access (P2b-04).
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    pkey(product, release),
    ingestFor(SERVICES),
  );
  expect(res.ok).toBe(true);
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  return { db, env, cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

type Ctx = Awaited<ReturnType<typeof linked>>;

/** The `app` row of Distribution's delivery access (P2b-04). */
async function deliveryAccess(
  ctx: Ctx,
): Promise<{ mode: string; source: string } | null> {
  return ctx.db.first<{ mode: string; source: string }>(
    "SELECT mode, source FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
    SLUG,
  );
}

async function call(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { cookie: ctx.cookie };
  if (method !== "GET") headers[CSRF_HEADER] = ctx.csrf;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const req = new Request(
    `https://key.plrs.im/manage${path}`,
    init,
  ) as unknown as Request;
  const res = await handleAdmin(req, ctx.env, ctx.db, path, { now: NOW });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

interface SettingView {
  value: unknown;
  source: string;
  version: number;
}

async function read(ctx: Ctx, key: string): Promise<SettingView> {
  return (await call(ctx, "GET", KEY(key))).json.setting as SettingView;
}

/** A write of `key` with the version the caller just read, as the console does. */
async function put(ctx: Ctx, key: string, value: unknown) {
  return call(ctx, "PATCH", KEY(key), {
    value,
    expectedVersion: (await read(ctx, key)).version,
  });
}

/** Revert (or reset) `key`, with the version the caller just read. */
async function revert(ctx: Ctx, key: string) {
  return call(ctx, "DELETE", KEY(key), {
    expectedVersion: (await read(ctx, key)).version,
  });
}

async function resync(ctx: Ctx, fetchImpl: FetchImpl, at = NOW + 60) {
  const res = await resyncRepo(
    ctx.env,
    ctx.db,
    SLUG,
    at,
    fetchImpl,
    ingestFor(SERVICES),
  );
  expect(res.ok).toBe(true);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("operator-owned access modes survive a resync", () => {
  // P2b-04 split the pair: the METADATA mode stays Release's (`release_config`, claimed through
  // `update/settings`); the ARTIFACTS mode is Distribution's delivery access (`dist_access`,
  // claimed through `…/distribution/access`). Each keeps P0-01's guarantee on its own owner.

  it("keeps an `entitled` delivery access after a push whose manifest says public", async () => {
    const ctx = await linked(chainProduct());
    const saved = await put(ctx, ACCESS, { app: { mode: "entitled" } });
    expect(saved.status).toBe(200);
    expect((saved.json.setting as SettingView).value).toMatchObject({
      app: { mode: "entitled", source: "admin" },
    });

    await resync(
      ctx,
      pkey(
        chainProduct(),
        releaseJson({ metadata: "public", artifacts: "public" }),
      ),
    );

    expect(await deliveryAccess(ctx)).toEqual({
      mode: "entitled",
      source: "admin",
    });
  });

  it("keeps an `entitled` metadata mode after a push whose manifest says public", async () => {
    const ctx = await linked(chainProduct());
    const patched = await put(ctx, METADATA, "entitled");
    expect(patched.status).toBe(200);
    expect(patched.json.setting).toMatchObject({
      value: "entitled",
      source: "console",
    });
    await resync(
      ctx,
      pkey(
        chainProduct(),
        releaseJson({ metadata: "public", artifacts: "public" }),
      ),
    );
    const cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(cfg?.metadata_access).toBe("entitled");
    expect(cfg?.access_source).toBe("admin");
  });

  it("claims each mode on its own owner: a resync still writes the other", async () => {
    const ctx = await linked(chainProduct());
    await put(ctx, METADATA, "licensed");
    await resync(
      ctx,
      pkey(
        chainProduct(),
        releaseJson({ metadata: "authenticated", artifacts: "licensed" }),
      ),
    );
    // Metadata was claimed and kept; delivery access was not, and followed the manifest.
    expect((await getReleaseConfig(ctx.db, SLUG))?.metadata_access).toBe(
      "licensed",
    );
    expect(await deliveryAccess(ctx)).toEqual({
      mode: "licensed",
      source: "manifest",
    });
  });

  it("returns to the manifest after a revert, on the NEXT resync only", async () => {
    const ctx = await linked(chainProduct());
    await put(ctx, ACCESS, { app: { mode: "entitled" } });

    const reverted = await revert(ctx, ACCESS);
    expect(reverted.status).toBe(200);
    // The revert flips the owner and changes nothing else.
    expect((reverted.json.setting as SettingView).value).toMatchObject({
      app: { mode: "entitled", source: "manifest" },
    });

    await resync(
      ctx,
      pkey(
        chainProduct(),
        releaseJson({ metadata: "public", artifacts: "licensed" }),
      ),
    );
    expect(await deliveryAccess(ctx)).toEqual({
      mode: "licensed",
      source: "manifest",
    });
  });

  it("serves no artifacts mode of its own: it is the delivery access", async () => {
    const ctx = await linked(chainProduct());
    const res = await call(ctx, "PATCH", KEY("update.artifactsAccess"), {
      value: "entitled",
      expectedVersion: 0,
    });
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ reason: "unknown_setting" });
    expect(await deliveryAccess(ctx)).toEqual({
      mode: "public",
      source: "manifest",
    });
  });
});

describe("the operator-owned compatibility window survives a resync", () => {
  it("keeps 2.0.0 over a manifest 1.0.0, and follows the manifest again after a revert", async () => {
    const ctx = await linked(productJson("1.0.0"));
    const patched = await put(ctx, WINDOW, { min: "2.0.0", max: "9.0.0" });
    expect(patched.status).toBe(200);
    expect(patched.json.setting).toMatchObject({
      value: { min: "2.0.0", max: "9.0.0" },
      source: "console",
    });

    const fetchImpl = pkey(
      productJson("1.0.0"),
      releaseJson({ metadata: "public", artifacts: "public" }),
    );
    await resync(ctx, fetchImpl);
    let row = await getProduct(ctx.db, SLUG);
    expect(row?.compat_min).toBe("2.0.0");
    expect(row?.compat_source).toBe("admin");

    const reverted = await revert(ctx, WINDOW);
    expect(reverted.status).toBe(200);
    // The window stays as the operator left it until the next resync.
    expect(reverted.json).toMatchObject({
      applied: false,
      setting: { value: { min: "2.0.0" }, source: "manifest" },
    });

    await resync(ctx, fetchImpl, NOW + 120);
    row = await getProduct(ctx.db, SLUG);
    expect(row?.compat_min).toBe("1.0.0");
    expect(row?.compat_source).toBe("manifest");
  });

  it("still rewrites the product's other manifest fields while the window is claimed", async () => {
    const ctx = await linked(productJson("1.0.0"));
    await put(ctx, WINDOW, { min: "2.0.0", max: "9.0.0" });
    await resync(
      ctx,
      pkey(
        JSON.stringify({
          ...JSON.parse(productJson("1.0.0")),
          name: "Acme Renamed",
        }),
        releaseJson({ metadata: "public", artifacts: "public" }),
      ),
    );
    const row = await getProduct(ctx.db, SLUG);
    expect(row?.name).toBe("Acme Renamed");
    expect(row?.compat_min).toBe("2.0.0");
  });
});

describe("the operator-only artifact policy survives a resync", () => {
  it("renders minimumSystemVersion in the appcast after a push, and keeps the signature opt-out", async () => {
    const ctx = await linked();
    const patched = await put(ctx, POLICY, {
      minimumSystemVersion: "13.0",
      requireSparkleSignature: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.setting).toMatchObject({
      value: { minimumSystemVersion: "13.0", requireSparkleSignature: false },
    });

    // A push that rewrites the manifest-owned half of the policy.
    const fetchImpl = pkey(
      productJson("1.0.0"),
      releaseJson(
        { metadata: "public", artifacts: "public" },
        { requireCli: false, architectures: ["arm64"] },
      ),
    );
    await resync(ctx, fetchImpl);

    const cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(JSON.parse(cfg?.operator_policy_json ?? "null")).toEqual({
      requireSparkleSignature: false,
      minimumSystemVersion: "13.0",
    });
    // The manifest blob carries only manifest keys.
    expect(cfg?.artifact_policy_json).not.toContain("minimumSystemVersion");
    expect(cfg?.artifact_policy_json).not.toContain("requireSparkleSignature");

    const product = (await loadProduct(ctx.env, ctx.db, SLUG))!;
    const res = await handleUpdate(
      new Request(
        `https://key.plrs.im/${SLUG}/update/appcast.xml`,
      ) as unknown as Request,
      ctx.env,
      ctx.db,
      product,
      "appcast",
      { arch: "arm64" },
      fetchImpl,
    );
    // Unsigned and still served: the opt-out survived. With it gone, a product with no Sparkle
    // key would 404 here.
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "<sparkle:minimumSystemVersion>13.0</sparkle:minimumSystemVersion>",
    );
  });

  it("answers the same appcast whatever the legacy release_config.artifacts_access holds (ST-25.2)", async () => {
    const ctx = await linked(
      productJson("1.0.0"),
      releaseJson({ metadata: "public", artifacts: "licensed" }),
    );
    await put(ctx, POLICY, { requireSparkleSignature: false });
    const fetchImpl = pkey(
      productJson("1.0.0"),
      releaseJson({ metadata: "public", artifacts: "licensed" }),
    );
    const product = (await loadProduct(ctx.env, ctx.db, SLUG))!;
    const ask = async () => {
      const res = await handleUpdate(
        new Request(
          `https://key.plrs.im/${SLUG}/update/appcast.xml`,
        ) as unknown as Request,
        ctx.env,
        ctx.db,
        product,
        "appcast",
        { arch: "arm64" },
        fetchImpl,
      );
      return { status: res.status, body: await res.text() };
    };
    const answers = [];
    for (const legacy of ["public", "authenticated", "licensed", "entitled"]) {
      await ctx.db.run(
        "UPDATE release_config SET artifacts_access = ? WHERE product = ?",
        legacy,
        SLUG,
      );
      answers.push(await ask());
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
  });

  it("audits the policy change as its own event, naming a disabled signature requirement", async () => {
    const ctx = await linked();
    await put(ctx, POLICY, { requireSparkleSignature: false });
    const rows = await listAudit(ctx.db, SLUG, { limit: 10 });
    const policy = rows.find((r) => r.action === "release.policy.update");
    expect(policy).toBeDefined();
    expect(JSON.stringify(policy)).toContain(
      "DISABLED the Sparkle signature requirement",
    );
  });

  it("resets the policy to its defaults and refuses a malformed one", async () => {
    const ctx = await linked();
    await put(ctx, POLICY, { minimumSystemVersion: "13.0" });
    for (const [value, field] of [
      [{ minimumSystemVersion: "thirteen" }, "minimumSystemVersion"],
      [{ minimumSystemVersion: "13.0.0.1" }, "minimumSystemVersion"],
      [{ minimumSystemVersion: 13 }, "minimumSystemVersion"],
      [{ requireSparkleSignature: "no" }, "requireSparkleSignature"],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await put(ctx, POLICY, value);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ fields: [field] });
    }
    // Nothing was written on the way to any refusal.
    expect((await read(ctx, POLICY)).value).toMatchObject({
      minimumSystemVersion: "13.0",
    });

    const cleared = await revert(ctx, POLICY);
    expect(cleared.status).toBe(200);
    expect((cleared.json.setting as SettingView).value).toEqual({
      requireSparkleSignature: true,
    });
    expect((await getReleaseConfig(ctx.db, SLUG))?.operator_policy_json).toBe(
      null,
    );
  });
});

describe("a product no operator has touched", () => {
  it("follows every manifest change", async () => {
    const ctx = await linked(
      productJson("1.0.0", "9.0.0"),
      releaseJson({ metadata: "public", artifacts: "public" }),
    );
    let row = await getProduct(ctx.db, SLUG);
    let cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(row?.compat_source).toBe("manifest");
    expect(cfg?.access_source).toBe("manifest");
    expect(cfg?.operator_policy_json ?? null).toBe(null);

    await resync(
      ctx,
      pkey(
        productJson("3.0.0", "4.0.0"),
        releaseJson(
          { metadata: "authenticated", artifacts: "licensed" },
          { requireDmg: false },
        ),
      ),
    );

    row = await getProduct(ctx.db, SLUG);
    cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(row?.compat_min).toBe("3.0.0");
    expect(row?.compat_max).toBe("4.0.0");
    expect(cfg?.metadata_access).toBe("authenticated");
    expect(
      (
        await ctx.db.first<{ mode: string }>(
          "SELECT mode FROM dist_access WHERE product = ? AND deliverable_id = 'app'",
          SLUG,
        )
      )?.mode,
    ).toBe("licensed");
    // ST-25.2: the legacy column is no longer written, so it keeps its link-time default.
    expect(
      (
        await ctx.db.first<{ artifacts_access: string }>(
          "SELECT artifacts_access FROM release_config WHERE product = ?",
          SLUG,
        )
      )?.artifacts_access,
    ).toBe("public");
    expect(JSON.parse(cfg?.artifact_policy_json ?? "{}")).toMatchObject({
      requireDmg: false,
    });
    // And the operator half stays on its fail-safe defaults.
    expect(cfg?.operator_policy_json ?? null).toBe(null);
    expect(await read(ctx, POLICY)).toMatchObject({
      value: { requireSparkleSignature: true },
    });
    expect(await read(ctx, METADATA)).toMatchObject({ source: "manifest" });
    expect(await read(ctx, WINDOW)).toMatchObject({ source: "manifest" });
  });
});

describe("reverting the update settings", () => {
  it("refuses a revert without the version it read", async () => {
    const ctx = await linked();
    await put(ctx, METADATA, "entitled");
    const res = await call(ctx, "DELETE", KEY(METADATA), {});
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ reason: "expected_version_required" });
  });

  it("refuses to revert what is not claimed", async () => {
    const ctx = await linked();
    const res = await revert(ctx, METADATA);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ reason: "not_claimed" });
  });

  it("reverts both blocks and audits each", async () => {
    const ctx = await linked();
    await put(ctx, METADATA, "entitled");
    await put(ctx, WINDOW, { min: "1.0.0", max: "8.0.0" });
    for (const key of [WINDOW, METADATA]) {
      const res = await revert(ctx, key);
      expect(res.status).toBe(200);
      expect((res.json.setting as SettingView).source).toBe("manifest");
    }
    // The values stay as the operator left them until the next resync.
    expect(await read(ctx, METADATA)).toMatchObject({ value: "entitled" });
    expect(await read(ctx, WINDOW)).toMatchObject({
      value: { max: "8.0.0" },
    });
    const rows = await listAudit(ctx.db, SLUG, { limit: 10 });
    expect(
      rows.filter((r) => r.action === "update.settings.revert"),
    ).toHaveLength(2);
  });
});

// ── Migration 0022_d ─────────────────────────────────────────────────────────────────────

async function insertCfg(
  db: Db,
  product: string,
  artifactPolicyJson: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
        default_max_offline_days, default_device_limit, created_at, modified_at)
      VALUES (?, ?, 'k', 'p', '0.0.0', '99.0.0', 30, 5, ?, ?)`,
    product,
    product,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO release_config (product, gh_owner, gh_repo, summary_marker, artifact_policy_json)
      VALUES (?, 'o', 'r', 'pkey:summary', ?)`,
    product,
    artifactPolicyJson,
  );
}

async function operatorJson(db: Db, product: string): Promise<string | null> {
  return (
    (
      await db.first<{ operator_policy_json: string | null }>(
        "SELECT operator_policy_json FROM release_config WHERE product = ?",
        product,
      )
    )?.operator_policy_json ?? null
  );
}

describe("migration 0022_d (operator policy backfill)", () => {
  it("copies hand-set operator keys, keeps booleans boolean, and is a no-op on replay", async () => {
    const db = makeTestDb();
    await insertCfg(
      db,
      "handset",
      JSON.stringify({
        requireDmg: true,
        architectures: ["arm64"],
        requireSparkleSignature: false,
        minimumSystemVersion: "13.0",
      }),
    );
    await insertCfg(db, "manifestonly", JSON.stringify({ requireCli: true }));
    await insertCfg(db, "empty", null);
    await insertCfg(db, "garbled", "{not json");

    await db.run(BACKFILL_SQL);

    // JSON `false`, not the integer 0 `json_extract` would have produced.
    expect(JSON.parse((await operatorJson(db, "handset"))!)).toEqual({
      requireSparkleSignature: false,
      minimumSystemVersion: "13.0",
    });
    expect(await operatorJson(db, "manifestonly")).toBe(null);
    expect(await operatorJson(db, "empty")).toBe(null);
    // A malformed blob neither aborts the statement nor gets copied.
    expect(await operatorJson(db, "garbled")).toBe(null);

    // An operator edits the policy after the deploy; a replay must not clobber it.
    await db.run(
      "UPDATE release_config SET operator_policy_json = ? WHERE product = 'handset'",
      JSON.stringify({ requireSparkleSignature: true }),
    );
    await db.run(BACKFILL_SQL);
    expect(JSON.parse((await operatorJson(db, "handset"))!)).toEqual({
      requireSparkleSignature: true,
    });
    expect(await operatorJson(db, "manifestonly")).toBe(null);
  });
});
