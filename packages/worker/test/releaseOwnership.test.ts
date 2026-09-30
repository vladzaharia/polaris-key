/**
 * Operator ownership of release settings across a manifest resync (P0-01).
 *
 * `resyncRepo` used to rewrite the compat window, both access modes and the whole
 * `artifact_policy_json` blob on every `.pkey/` push. `entitled` has no manifest spelling, so any
 * push silently downgraded an entitled product to the manifest's mode (default `public`), and the
 * operator-only keys that lived inside `artifact_policy_json` were erased with the blob.
 *
 * The fix follows `services_source`: two ownership markers (`products.compat_source`,
 * `release_config.access_source`) that `update/settings` claims and resync's own UPDATE honours,
 * plus a separate `release_config.operator_policy_json` that no manifest path writes at all.
 *
 * Every case here drives the REAL path: `linkRepo` registers the product from a stubbed GitHub,
 * the console API (`handleAdmin`) makes the operator's edit, and `resyncRepo` re-reads a changed
 * `.pkey/` from the same stub.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release } from "../src/services/release/github.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import { loadProduct } from "../src/core/products.js";
import { getProduct, listAudit } from "../src/repo.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { getReleaseConfig } from "../src/services/release/index.js";
import { handleUpdate } from "../src/services/update/index.js";

const SLUG = "acme";
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";
const SETTINGS = `/api/products/${SLUG}/update/settings`;
const REVERT = `${SETTINGS}/revert`;

const HERE = dirname(fileURLToPath(import.meta.url));
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

function productJson(compatMin: string, compatMax = "9.0.0"): string {
  return JSON.stringify({
    slug: SLUG,
    name: "Acme",
    compatMin,
    compatMax,
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    adminGroup: "acme-admins",
    tiers: [],
    provisioning: [],
  });
}

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
  return async (input) => {
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
  };
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
  const res = await linkRepo(
    env,
    db,
    "acme-org/acme-app",
    NOW,
    pkey(product, release),
  );
  expect(res.ok).toBe(true);
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  return { db, env, cookie: `${ADMIN_COOKIE}=${token}`, csrf: session.csrf };
}

type Ctx = Awaited<ReturnType<typeof linked>>;

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

async function resync(ctx: Ctx, fetchImpl: FetchImpl, at = NOW + 60) {
  const res = await resyncRepo(ctx.env, ctx.db, SLUG, at, fetchImpl);
  expect(res.ok).toBe(true);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("operator-owned access modes survive a resync", () => {
  it("keeps `entitled` after a push whose manifest says public", async () => {
    const ctx = await linked();
    const patched = await call(ctx, "PATCH", SETTINGS, {
      artifactsAccess: "entitled",
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      artifactsAccess: "entitled",
      accessSource: "admin",
    });

    await resync(
      ctx,
      pkey(
        productJson("1.0.0"),
        releaseJson({ metadata: "public", artifacts: "public" }),
      ),
    );

    const cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(cfg?.artifacts_access).toBe("entitled");
    expect(cfg?.access_source).toBe("admin");
  });

  it("claims BOTH modes, even when only one was saved", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", SETTINGS, { artifactsAccess: "licensed" });
    await resync(
      ctx,
      pkey(
        productJson("1.0.0"),
        releaseJson({ metadata: "authenticated", artifacts: "public" }),
      ),
    );
    const cfg = await getReleaseConfig(ctx.db, SLUG);
    expect(cfg?.metadata_access).toBe("public");
    expect(cfg?.artifacts_access).toBe("licensed");
  });

  it("returns to the manifest after a revert, on the NEXT resync only", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", SETTINGS, { artifactsAccess: "entitled" });

    const reverted = await call(ctx, "POST", REVERT, { fields: ["access"] });
    expect(reverted.status).toBe(200);
    // The revert flips the owner and changes nothing else.
    expect(reverted.json).toMatchObject({
      artifactsAccess: "entitled",
      accessSource: "manifest",
    });

    await resync(
      ctx,
      pkey(
        productJson("1.0.0"),
        releaseJson({ metadata: "public", artifacts: "licensed" }),
      ),
    );
    expect((await getReleaseConfig(ctx.db, SLUG))?.artifacts_access).toBe(
      "licensed",
    );
  });
});

describe("the operator-owned compatibility window survives a resync", () => {
  it("keeps 2.0.0 over a manifest 1.0.0, and follows the manifest again after a revert", async () => {
    const ctx = await linked(productJson("1.0.0"));
    const patched = await call(ctx, "PATCH", SETTINGS, { compatMin: "2.0.0" });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      compatMin: "2.0.0",
      compatSource: "admin",
    });

    const fetchImpl = pkey(
      productJson("1.0.0"),
      releaseJson({ metadata: "public", artifacts: "public" }),
    );
    await resync(ctx, fetchImpl);
    let row = await getProduct(ctx.db, SLUG);
    expect(row?.compat_min).toBe("2.0.0");
    expect(row?.compat_source).toBe("admin");

    const reverted = await call(ctx, "POST", REVERT, { fields: ["compat"] });
    expect(reverted.status).toBe(200);
    expect(reverted.json).toMatchObject({
      compatMin: "2.0.0",
      compatSource: "manifest",
    });

    await resync(ctx, fetchImpl, NOW + 120);
    row = await getProduct(ctx.db, SLUG);
    expect(row?.compat_min).toBe("1.0.0");
    expect(row?.compat_source).toBe("manifest");
  });

  it("still rewrites the product's other manifest fields while the window is claimed", async () => {
    const ctx = await linked(productJson("1.0.0"));
    await call(ctx, "PATCH", SETTINGS, { compatMin: "2.0.0" });
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
    const patched = await call(ctx, "PATCH", SETTINGS, {
      minimumSystemVersion: "13.0",
      requireSparkleSignature: false,
    });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({
      minimumSystemVersion: "13.0",
      requireSparkleSignature: false,
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

  it("audits the policy change as its own event, naming a disabled signature requirement", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", SETTINGS, { requireSparkleSignature: false });
    const rows = await listAudit(ctx.db, SLUG, { limit: 10 });
    const policy = rows.find((r) => r.action === "release.policy.update");
    expect(policy).toBeDefined();
    expect(JSON.stringify(policy)).toContain(
      "DISABLED the Sparkle signature requirement",
    );
    expect(rows.map((r) => r.action)).toContain("update.settings.update");
  });

  it("clears minimumSystemVersion with null and refuses a malformed one", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", SETTINGS, { minimumSystemVersion: "13.0" });
    for (const [body, field] of [
      [{ minimumSystemVersion: "thirteen" }, "minimumSystemVersion"],
      [{ minimumSystemVersion: "13.0.0.1" }, "minimumSystemVersion"],
      [{ minimumSystemVersion: 13 }, "minimumSystemVersion"],
      [{ requireSparkleSignature: "no" }, "requireSparkleSignature"],
    ] as Array<[Record<string, unknown>, string]>) {
      const res = await call(ctx, "PATCH", SETTINGS, body);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ fields: [field] });
    }
    // Nothing was written on the way to any refusal.
    expect((await call(ctx, "GET", SETTINGS)).json.minimumSystemVersion).toBe(
      "13.0",
    );

    const cleared = await call(ctx, "PATCH", SETTINGS, {
      minimumSystemVersion: null,
    });
    expect(cleared.json).toMatchObject({ minimumSystemVersion: null });
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
    expect(cfg?.artifacts_access).toBe("licensed");
    expect(JSON.parse(cfg?.artifact_policy_json ?? "{}")).toMatchObject({
      requireDmg: false,
    });
    // And the operator half stays on its fail-safe defaults.
    expect(cfg?.operator_policy_json ?? null).toBe(null);
    expect((await call(ctx, "GET", SETTINGS)).json).toMatchObject({
      requireSparkleSignature: true,
      minimumSystemVersion: null,
      accessSource: "manifest",
      compatSource: "manifest",
    });
  });
});

describe("update/settings/revert", () => {
  it("refuses an empty, unknown or non-array field list", async () => {
    const ctx = await linked();
    for (const body of [
      {},
      { fields: [] },
      { fields: ["channels"] },
      { fields: "access" },
      { fields: ["access", 7] },
    ]) {
      const res = await call(ctx, "POST", REVERT, body);
      expect(res.status).toBe(422);
      expect(res.json).toMatchObject({ fields: ["fields"] });
    }
  });

  it("refuses the wrong method", async () => {
    const ctx = await linked();
    expect((await call(ctx, "GET", REVERT)).status).toBe(405);
  });

  it("reverts both blocks at once and audits it", async () => {
    const ctx = await linked();
    await call(ctx, "PATCH", SETTINGS, {
      artifactsAccess: "entitled",
      compatMax: "8.0.0",
    });
    const res = await call(ctx, "POST", REVERT, {
      fields: ["compat", "access"],
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      accessSource: "manifest",
      compatSource: "manifest",
      artifactsAccess: "entitled",
      compatMax: "8.0.0",
    });
    const rows = await listAudit(ctx.db, SLUG, { limit: 10 });
    expect(rows.map((r) => r.action)).toContain("update.settings.revert");
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
