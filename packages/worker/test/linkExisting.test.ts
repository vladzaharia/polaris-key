/**
 * Link repository for a product that already exists (UX-23, `services/release/linkExisting.ts`):
 * the dry run checks and plans without writing, the link re-checks against the manifest GitHub
 * serves now and applies it through `resyncRepo`, and every refusal names the check it failed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import {
  makeEnv,
  NOW,
  seedLicenseWithKey,
  seedProduct,
  seedTier,
} from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "./githubHead.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import {
  linkExistingProduct,
  planRepoManifest,
  prepareLink,
} from "../src/services/release/linkExisting.js";
import { parseManifest } from "../src/services/release/manifest.js";
import { getReleaseConfig } from "../src/services/release/index.js";
import { getActiveSchema, getProduct, setServices } from "../src/repo.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";

function envFor(): Env {
  const env = makeEnv(new KvMock(), []);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  env.OIDC_ISSUER_ALLOWLIST = "id.example";
  return env;
}

function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

/** Installation discovery, the token exchange and `.pkey/` files; `installed: false` 404s. */
function stubFetch(
  files: Record<string, string>,
  opts: { installed?: boolean; identity?: boolean } = {},
): FetchImpl {
  return withDefaultHead(async (input) => {
    const url = String(input);
    if (opts.identity === false && /\/repos\/[^/]+\/[^/]+$/.test(url))
      return new Response("boom", { status: 502 });
    if (url.includes("/installation"))
      return opts.installed === false
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_t" }), { status: 200 });
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`)) return contents(body);
      return new Response("not found", { status: 404 });
    }
    // The release list (the truth-store sync): none yet.
    if (url.includes("/releases")) return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

const SCHEMA = JSON.stringify({
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

function productJson(slug = "tonebox", extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    slug,
    name: "Tonebox",
    compatMin: "1.0.0",
    compatMax: "9.0.0",
    defaultMaxOfflineDays: 14,
    defaultDeviceLimit: 3,
    tiers: [
      {
        id: "pro",
        label: "Pro",
        profileId: null,
        policyExpiryDays: 365,
        policyDeviceLimit: 5,
      },
    ],
    provisioning: [],
    ...extra,
  });
}

const RELEASE = JSON.stringify({
  release: { ghOwner: "acme", ghRepo: "tonebox", binaryName: "tonebox" },
});

function files(product = productJson()): Record<string, string> {
  return {
    ".pkey/schema.json": SCHEMA,
    ".pkey/product.json": product,
    ".pkey/release.json": RELEASE,
  };
}

async function manualProduct(): Promise<{ db: Db; env: Env }> {
  const db = makeTestDb();
  const env = envFor();
  await seedProduct(db, "tonebox");
  return { db, env };
}

const URL_ = "https://github.com/acme/tonebox";

describe("prepareLink (the dry run)", () => {
  it("checks a manual product and plans the hand-over without writing anything", async () => {
    const { db, env } = await manualProduct();
    await seedTier(db, "tonebox", "legacy");
    const res = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(files()),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repository).toBe("acme/tonebox");
    expect(res.commit).toBe(HEAD_SHA);
    expect(res.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    const areas = res.plan.apply.map((i) => i.area);
    expect(areas[0]).toBe("source");
    expect(areas).toEqual(
      expect.arrayContaining([
        "product",
        "compat",
        "catalog",
        "tiers",
        "release",
      ]),
    );
    expect(res.plan.apply.find((i) => i.area === "catalog")?.summary).toContain(
      "adds run.concurrency",
    );
    // A tier the manifest drops, with no licence on it, goes.
    expect(res.plan.delete).toContainEqual({
      area: "tiers",
      id: "legacy",
      summary: "Tier legacy",
    });
    expect(res.plan.conflicts).toEqual([]);
    // Nothing written.
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
    expect(await getReleaseConfig(db, "tonebox")).toBeNull();
  });

  it("refuses with the check that failed: repository, app, manifest, slug", async () => {
    const { db, env } = await manualProduct();
    const bad = await prepareLink(
      env,
      db,
      "tonebox",
      "not a url",
      NOW,
      stubFetch(files()),
    );
    expect(bad).toMatchObject({ ok: false, check: "repository", status: 422 });

    const notInstalled = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(files(), { installed: false }),
    );
    expect(notInstalled).toMatchObject({ ok: false, check: "app" });

    const invalid = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch({ ".pkey/schema.json": SCHEMA }),
    );
    expect(invalid).toMatchObject({ ok: false, check: "manifest" });
    if (!invalid.ok) expect(invalid.errors?.length).toBeGreaterThan(0);

    const other = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(files(productJson("ghost"))),
    );
    expect(other).toMatchObject({
      ok: false,
      check: "slug",
      error: "manifest slug ghost does not match product tonebox",
    });
  });

  it("parses with the platform's reserved-name severity (LX-05)", async () => {
    const { db, env } = await manualProduct();
    env.LICENSING_RESERVED_NAMES = "error";
    const reserved = JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          key: "deviceLimit",
          kind: "flag",
          category: "Seats",
          label: "Seats",
          description: "",
          schema: { type: "boolean" },
        },
      ],
    });
    const res = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch({ ...files(), ".pkey/schema.json": reserved }),
    );
    expect(res).toMatchObject({ ok: false, check: "manifest" });
    if (!res.ok)
      expect(res.errors?.join("\n")).toContain(
        "deviceLimit is a reserved entitlement name",
      );
  });

  it("refuses an issuer outside the allowlist before anything is written", async () => {
    const { db, env } = await manualProduct();
    const res = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(
        files(
          productJson("tonebox", {
            oidc: {
              provider: "custom",
              issuer: "https://evil.example",
              clientId: "c",
              clientSecretSecret: "OIDC_SECRET__TONEBOX",
              redirectUris: ["https://tonebox.example/cb"],
            },
          }),
        ),
      ),
    );
    expect(res).toMatchObject({ ok: false, check: "policy" });
  });

  it("refuses a product that is already linked, and the system product", async () => {
    const { db, env } = await manualProduct();
    await db.run(
      "UPDATE products SET release_source = 'github' WHERE slug = 'tonebox'",
    );
    const res = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(files()),
    );
    expect(res).toMatchObject({ ok: false, check: "product" });
    if (!res.ok) expect(res.error).toContain("already linked");

    await seedProduct(db, "polaris-key");
    await db.run("UPDATE products SET system = 1 WHERE slug = 'polaris-key'");
    const system = await prepareLink(
      env,
      db,
      "polaris-key",
      URL_,
      NOW,
      stubFetch(files()),
    );
    expect(system).toMatchObject({ ok: false, check: "product" });
    if (!system.ok) expect(system.error).toContain("deploy hook");
  });

  it("a dropped tier that licences use is a conflict, and the link refuses it whole", async () => {
    const { db, env } = await manualProduct();
    await seedTier(db, "tonebox", "legacy");
    await seedLicenseWithKey(db, "tonebox", { tierId: "legacy" });
    const fetchImpl = stubFetch(files());
    const res = await prepareLink(env, db, "tonebox", URL_, NOW, fetchImpl);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.conflicts).toHaveLength(1);
    expect(res.plan.conflicts[0]).toMatchObject({
      area: "tiers",
      id: "legacy",
    });

    const linked = await linkExistingProduct(
      env,
      db,
      "tonebox",
      URL_,
      res.manifestDigest,
      NOW,
      fetchImpl,
    );
    expect(linked).toMatchObject({ ok: false, check: "policy", status: 422 });
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
    expect(await getReleaseConfig(db, "tonebox")).toBeNull();
  });

  it("services an operator set in the console are planned as kept, and stay kept", async () => {
    const { db, env } = await manualProduct();
    await setServices(
      db,
      "tonebox",
      JSON.stringify({
        license: { enabled: false },
        config: { enabled: true },
      }),
      "admin",
      NOW,
    );
    const manifest = parseManifest({
      schema: SCHEMA,
      product: productJson(),
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const plan = await planRepoManifest(db, "tonebox", manifest.manifest, NOW);
    expect(plan.skipClaimed.map((i) => i.area)).toContain("services");
    expect(plan.apply.map((i) => i.area)).not.toContain("services");
  });
  it("console-owned tiers are planned as kept, as the apply keeps them (ST-01b)", async () => {
    const { db } = await manualProduct();
    await seedTier(db, "tonebox", "pro");
    await seedTier(db, "tonebox", "custom");
    await db.run(
      "UPDATE tiers SET source = 'console' WHERE product = ? AND id IN ('pro', 'custom')",
      "tonebox",
    );
    const manifest = parseManifest({
      schema: SCHEMA,
      product: productJson(),
    });
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const plan = await planRepoManifest(db, "tonebox", manifest.manifest, NOW);
    // The manifest's "pro" is not applied over the console's row; it is reported as kept.
    expect(
      plan.skipClaimed.filter((i) => i.area === "tiers").map((i) => i.id),
    ).toEqual(["pro"]);
    expect(
      plan.apply.filter((i) => i.area === "tiers").map((i) => i.id),
    ).toEqual([]);
    // A console-only tier the manifest omits is neither deleted nor a conflict.
    expect(plan.delete.map((i) => i.id)).not.toContain("custom");
    expect(plan.conflicts).toEqual([]);
  });
});

describe("linkExistingProduct", () => {
  it("links, applies the manifest through resync, and keeps the signing key", async () => {
    const { db, env } = await manualProduct();
    const fetchImpl = stubFetch(files());
    const check = await prepareLink(env, db, "tonebox", URL_, NOW, fetchImpl);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const kidBefore = (await getProduct(db, "tonebox"))?.signing_kid;

    const res = await linkExistingProduct(
      env,
      db,
      "tonebox",
      URL_,
      check.manifestDigest,
      NOW + 10,
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repository).toBe("acme/tonebox");
    expect(res.updated).toEqual(
      expect.arrayContaining(["product", "schema", "tiers"]),
    );

    const product = await getProduct(db, "tonebox");
    expect(product?.release_source).toBe("github");
    expect(product?.name).toBe("Tonebox");
    expect(product?.signing_kid).toBe(kidBefore);
    const cfg = await getReleaseConfig(db, "tonebox");
    expect(cfg).toMatchObject({
      gh_owner: "acme",
      gh_repo: "tonebox",
      gh_installation_id: 4242,
      binary_name: "tonebox",
    });
    const schema = await getActiveSchema(db, "tonebox");
    expect(schema?.catalog_version).toBe(2);
    const tiers = await db.all<{ id: string }>(
      "SELECT id FROM tiers WHERE product = 'tonebox'",
    );
    expect(tiers.map((t) => t.id)).toEqual(["pro"]);
  });

  it("refuses with 409 when the manifest changed since the check", async () => {
    const { db, env } = await manualProduct();
    const check = await prepareLink(
      env,
      db,
      "tonebox",
      URL_,
      NOW,
      stubFetch(files()),
    );
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const pushed = stubFetch(
      files(productJson("tonebox", { defaultDeviceLimit: 9 })),
    );
    const res = await linkExistingProduct(
      env,
      db,
      "tonebox",
      URL_,
      check.manifestDigest,
      NOW,
      pushed,
    );
    expect(res).toMatchObject({ ok: false, status: 409, check: "manifest" });
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
  });
});

describe("linkExistingProduct rolls back what it wrote", () => {
  const PUBLISHING = JSON.stringify({
    release: {
      ghOwner: "acme",
      ghRepo: "tonebox",
      binaryName: "tonebox",
      publishing: {
        trustedPublisher: { workflow: ".github/workflows/release.yml" },
      },
    },
  });

  it("a refusal after the coordinates are written puts the product back to manual", async () => {
    const { db, env } = await manualProduct();
    // The check never resolves the repository's ids; resync does (for the trusted publisher),
    // so failing that lookup refuses the apply after the link wrote its coordinates.
    const fetchImpl = stubFetch(
      { ...files(), ".pkey/release.json": PUBLISHING },
      { identity: false },
    );
    const check = await prepareLink(env, db, "tonebox", URL_, NOW, fetchImpl);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const res = await linkExistingProduct(
      env,
      db,
      "tonebox",
      URL_,
      check.manifestDigest,
      NOW,
      fetchImpl,
    );
    expect(res).toMatchObject({ ok: false, afterWrite: true, check: "policy" });
    if (!res.ok) expect(res.error).toContain("trustedPublisher");
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
    expect(await getReleaseConfig(db, "tonebox")).toBeNull();
  });

  it("a throw from the apply rolls back too, then propagates", async () => {
    const { db, env } = await manualProduct();
    const fetchImpl = stubFetch(files());
    const check = await prepareLink(env, db, "tonebox", URL_, NOW, fetchImpl);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    // The link's own batch (1st) and the rollback (3rd) go through; resync's batch (2nd) throws.
    let batches = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch")
          return async (...a: Parameters<Db["batch"]>) => {
            batches += 1;
            if (batches === 2) throw new Error("D1 went away");
            return target.batch(...a);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    await expect(
      linkExistingProduct(
        env,
        flaky,
        "tonebox",
        URL_,
        check.manifestDigest,
        NOW,
        fetchImpl,
      ),
    ).rejects.toThrow("D1 went away");
    expect(batches).toBe(3);
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
    expect(await getReleaseConfig(db, "tonebox")).toBeNull();
  });
});

describe("POST …/release/link (the console route)", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function call(
    env: Env,
    db: Db,
    path: string,
    body: unknown,
  ): Promise<Response> {
    env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
    env.PLATFORM_ADMIN_GROUP = "admins";
    const { token, session } = await issueSession(
      env,
      { sub: "u1", name: "Ada", email: "a@x.io", groups: ["admins"] },
      NOW,
    );
    // The query rides on the request URL; the router hands the handler the bare path.
    const req = new Request(`https://key.plrs.im/manage${path}`, {
      method: "POST",
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }) as unknown as Request;
    return handleAdmin(req, env, db, path.split("?")[0]!, { now: NOW + 60 });
  }

  it("dry run, then link: the plan, the digest, the audit row and the sync state", async () => {
    const { db, env } = await manualProduct();
    vi.stubGlobal("fetch", stubFetch(files()));

    const dry = await call(
      env,
      db,
      "/api/products/tonebox/release/link?dryRun=1",
      {
        repoUrl: URL_,
      },
    );
    expect(dry.status).toBe(200);
    const plan = (await dry.json()) as {
      dryRun: boolean;
      repository: string;
      manifestDigest: string;
      plan: { apply: { area: string }[] };
    };
    expect(plan.dryRun).toBe(true);
    expect(plan.repository).toBe("acme/tonebox");
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();

    const missing = await call(env, db, "/api/products/tonebox/release/link", {
      repoUrl: URL_,
    });
    expect(missing.status).toBe(422);

    const linked = await call(env, db, "/api/products/tonebox/release/link", {
      repoUrl: URL_,
      manifestDigest: plan.manifestDigest,
    });
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      ok: true,
      repository: "acme/tonebox",
    });
    expect((await getProduct(db, "tonebox"))?.release_source).toBe("github");
    const audit = await db.first<{ action: string; summary: string }>(
      "SELECT action, summary FROM audit WHERE product = 'tonebox' AND action = 'product.link'",
    );
    expect(audit?.summary).toBe("Linked tonebox to acme/tonebox");
    const sync = await db.first<{ status: string }>(
      "SELECT status FROM product_sync_state WHERE product = 'tonebox'",
    );
    expect(sync?.status).toBe("ok");
  });

  it("audits a link refused after its coordinates were written", async () => {
    const { db, env } = await manualProduct();
    vi.stubGlobal(
      "fetch",
      stubFetch(
        {
          ...files(),
          ".pkey/release.json": JSON.stringify({
            release: {
              ghOwner: "acme",
              ghRepo: "tonebox",
              binaryName: "tonebox",
              publishing: {
                trustedPublisher: { workflow: ".github/workflows/release.yml" },
              },
            },
          }),
        },
        { identity: false },
      ),
    );
    const dry = await call(
      env,
      db,
      "/api/products/tonebox/release/link?dryRun=1",
      {
        repoUrl: URL_,
      },
    );
    const { manifestDigest } = (await dry.json()) as { manifestDigest: string };
    const res = await call(env, db, "/api/products/tonebox/release/link", {
      repoUrl: URL_,
      manifestDigest,
    });
    expect(res.status).toBe(422);
    const audit = await db.first<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = 'tonebox' AND action = 'product.link.refused'",
    );
    expect(audit?.summary).toContain("put back to manual");
    expect((await getProduct(db, "tonebox"))?.release_source).toBeNull();
  });

  it("answers a refusal with the failed check", async () => {
    const { db, env } = await manualProduct();
    vi.stubGlobal("fetch", stubFetch(files(), { installed: false }));
    const res = await call(
      env,
      db,
      "/api/products/tonebox/release/link?dryRun=1",
      {
        repoUrl: URL_,
      },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ reason: "app" });
  });
});
