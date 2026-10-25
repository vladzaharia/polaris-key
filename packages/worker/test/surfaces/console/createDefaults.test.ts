/**
 * ST-42 (FLOWS W25): create with defaults. Both create routes take `services`,
 * `intendedPlatforms`, `starterTier` and (link only) `trustReleaseWorkflow`, and write the
 * product, key, catalog, Default profile, Free tier, planned platforms and trust policy in one
 * batch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../helpers.js";
import { KvMock } from "../../kvMock.js";
import { makeEnv, NOW } from "../../seed.js";
import { TEST_RSA_PKCS8 } from "../../releaseFixtures.js";
import { withDefaultHead } from "../../githubHead.js";
import type { Db } from "../../../src/db/types.js";
import type { Env } from "../../../src/platform/env.js";
import type { FetchImpl } from "../../../src/services/release/githubApp.js";
import { getProduct } from "../../../src/core/products/store.js";
import { handleAdmin } from "../../../src/console/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
} from "../../../src/core/console/session.js";
import { consoleTestSession } from "../../consoleSessionHelper.js";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = "admins";
  return env;
}

async function post(
  env: Env,
  db: Db,
  path: string,
  body: unknown,
): Promise<Response> {
  const { token, session } = await consoleTestSession(
    env,
    db,
    { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
    NOW,
  );
  const req = new Request(`https://key.plrs.im/manage${path}`, {
    method: "POST",
    headers: {
      cookie: `${ADMIN_COOKIE}=${token}`,
      [CSRF_HEADER]: session.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }) as unknown as Request;
  return handleAdmin(req, env, db, path, { now: NOW + 60 });
}

async function rows(db: Db, sql: string, ...params: unknown[]) {
  return (await db.all(sql, ...(params as never[]))) as Record<
    string,
    unknown
  >[];
}

describe("manual create with defaults", () => {
  it("writes the Default profile and the Free tier with no choices", async () => {
    const db = makeTestDb();
    const res = await post(envFor(), db, "/api/products", { slug: "tonebox" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      defaults: {
        services: ["license", "config"],
        profile: "default",
        tier: "free",
        intendedPlatforms: [],
        trustedWorkflow: null,
      },
    });
    expect(
      await rows(
        db,
        "SELECT id, source FROM profiles WHERE product = ?",
        "tonebox",
      ),
    ).toEqual([{ id: "default", source: "console" }]);
    expect(
      await rows(
        db,
        "SELECT id, profile_id, rank, source FROM tiers WHERE product = ? ORDER BY id",
        "tonebox",
      ),
    ).toEqual([
      // LX-33.7: the implicit Default tier is seeded beside the Free starter.
      { id: "default", profile_id: null, rank: 0, source: "console" },
      { id: "free", profile_id: "default", rank: 0, source: "console" },
    ]);
  });

  it("is written by the ingest pipeline from documents, with no repository (ST-43)", async () => {
    const db = makeTestDb();
    const res = await post(envFor(), db, "/api/products", {
      slug: "tonebox",
      name: "Tonebox",
    });
    expect(res.status).toBe(201);
    expect(
      await rows(
        db,
        "SELECT origin, applied_sha FROM product_manifest_snapshot WHERE product = ?",
        "tonebox",
      ),
    ).toEqual([{ origin: "link", applied_sha: null }]);
    expect(
      await rows(
        db,
        "SELECT name, release_source, default_max_offline_days, default_device_limit FROM products WHERE slug = ?",
        "tonebox",
      ),
    ).toEqual([
      {
        name: "Tonebox",
        release_source: null,
        default_max_offline_days: 30,
        default_device_limit: 5,
      },
    ]);
  });

  it("applies services through the chain rule, platforms and no tier", async () => {
    const db = makeTestDb();
    const res = await post(envFor(), db, "/api/products", {
      slug: "tonebox",
      services: ["license", "config", "release", "distribution"],
      intendedPlatforms: ["macos", "ios"],
      starterTier: "none",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      defaults: { services: string[]; tier: string | null };
    };
    expect(body.defaults.services).toEqual([
      "license",
      "config",
      "release",
      "distribution",
    ]);
    expect(body.defaults.tier).toBeNull();
    expect(
      await rows(db, "SELECT id FROM tiers WHERE product = ?", "tonebox"),
    ).toEqual([{ id: "default" }]); // LX-33.7: no starter tier, but the Default tier exists
    const setting = await rows(
      db,
      "SELECT value_json, source FROM product_settings WHERE product = ? AND key = ?",
      "tonebox",
      "distribution.intendedPlatforms",
    );
    expect(setting).toEqual([
      { value_json: '["macos","ios"]', source: "console" },
    ]);
    const product = await getProduct(db, "tonebox");
    expect(product?.services_source).toBe("admin");
  });

  it("refuses a service whose requirement is off, writing nothing", async () => {
    const db = makeTestDb();
    const res = await post(envFor(), db, "/api/products", {
      slug: "tonebox",
      services: ["license", "update"],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "update_requires_distribution" },
    });
    expect(await getProduct(db, "tonebox")).toBeNull();
  });

  it("refuses bad choices", async () => {
    const env = envFor();
    for (const [body, reason] of [
      [{ services: ["nope"] }, "unknown_service"],
      [{ intendedPlatforms: ["amiga"] }, "invalid_platforms"],
      [{ intendedPlatforms: ["macos", "macos"] }, "invalid_platforms"],
      [{ starterTier: "gold" }, "invalid_starter_tier"],
      [{ trustReleaseWorkflow: true }, "trust_requires_repository"],
      [
        { services: ["config"], starterTier: "free" },
        "starter_tier_requires_license",
      ],
    ] as const) {
      const db = makeTestDb();
      const res = await post(env, db, "/api/products", {
        slug: "tonebox",
        ...body,
      });
      expect(res.status, reason).toBe(422);
      expect(await res.json(), reason).toMatchObject({ error: { reason } });
      expect(await getProduct(db, "tonebox")).toBeNull();
    }
  });

  it("rolls the whole batch back when a row fails", async () => {
    const db = makeTestDb();
    // A leftover profile row for the slug makes the defaults' INSERT collide.
    await db.run("PRAGMA foreign_keys = OFF");
    await db.run(
      "INSERT INTO profiles (product, id, name, payload_json, modified_at) VALUES (?, 'default', 'x', '{}', 1)",
      "tonebox",
    );
    await expect(
      post(envFor(), db, "/api/products", { slug: "tonebox" }),
    ).rejects.toThrow();
    await db.run("PRAGMA foreign_keys = ON");
    expect(await getProduct(db, "tonebox")).toBeNull();
    expect(
      await rows(
        db,
        "SELECT kid FROM product_keys WHERE product = ?",
        "tonebox",
      ),
    ).toEqual([]);
  });

  it("no longer takes the compatibility window", async () => {
    const db = makeTestDb();
    await post(envFor(), db, "/api/products", {
      slug: "tonebox",
      compatMin: "3.0.0",
      compatMax: "4.0.0",
    });
    const p = await getProduct(db, "tonebox");
    expect([p?.compat_min, p?.compat_max]).toEqual(["0.0.0", "99.0.0"]);
  });
});

// ── link-repo ───────────────────────────────────────────────────────────────────────────────

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

const SCHEMA = JSON.stringify({ schemaVersion: 1, entries: [] });
const PRODUCT = JSON.stringify({
  slug: "tonebox",
  name: "Tonebox",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  tiers: [],
  provisioning: [],
});

function stubFetch(opts: { workflow: boolean }): FetchImpl {
  const files: Record<string, string> = {
    ".pkey/schema.json": SCHEMA,
    ".pkey/product.json": PRODUCT,
  };
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (url.includes("/installation") && !url.includes("/installations/"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      if (url.includes("/contents/.github/workflows/release.yml"))
        return opts.workflow
          ? contents("name: release")
          : new Response("nf", { status: 404 });
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(body);
      return new Response("nf", { status: 404 });
    }
    if (/\/repos\/acme\/tonebox$/.test(url))
      return new Response(
        JSON.stringify({ id: 77, full_name: "acme/tonebox", owner: { id: 9 } }),
        { status: 200 },
      );
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("nf", { status: 404 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("link-repo create with defaults", () => {
  it("adds the Default profile, Free tier, platforms, services and trust policy", async () => {
    const db = makeTestDb();
    vi.stubGlobal("fetch", stubFetch({ workflow: true }));
    const res = await post(envFor(), db, "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
      services: ["release", "distribution"],
      intendedPlatforms: ["macos"],
      trustReleaseWorkflow: true,
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      defaults: {
        services: ["license", "config", "release", "distribution"],
        profile: "default",
        tier: "free",
        intendedPlatforms: ["macos"],
        trustedWorkflow: ".github/workflows/release.yml",
      },
    });
    expect(
      await rows(
        db,
        "SELECT repository_id, repository, workflow, source FROM ci_publishers WHERE product = ?",
        "tonebox",
      ),
    ).toEqual([
      {
        repository_id: 77,
        repository: "acme/tonebox",
        workflow: ".github/workflows/release.yml",
        source: "admin",
      },
    ]);
    expect((await getProduct(db, "tonebox"))?.services_source).toBe("admin");
  });

  it("refuses to trust a workflow that is not there, creating nothing", async () => {
    const db = makeTestDb();
    vi.stubGlobal("fetch", stubFetch({ workflow: false }));
    const res = await post(envFor(), db, "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
      trustReleaseWorkflow: true,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "release_workflow_missing" },
    });
    expect(await getProduct(db, "tonebox")).toBeNull();
  });

  it("refuses a service whose requirement is off", async () => {
    const db = makeTestDb();
    vi.stubGlobal("fetch", stubFetch({ workflow: true }));
    const res = await post(envFor(), db, "/api/products/link-repo", {
      repoUrl: "acme/tonebox",
      services: ["distribution"],
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "distribution_requires_release" },
    });
    expect(await getProduct(db, "tonebox")).toBeNull();
  });
});
