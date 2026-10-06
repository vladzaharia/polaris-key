/**
 * The registry framework under the host (F-02, plans/F-01.md §6.5 to §6.7): the credential
 * extractor and `authorizeFeedRead`'s ladder, the 30-second settings cache, the Cache API layer
 * and its headers, and the render-on-write materialiser with a fake renderer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseAccess } from "@polaris-key/protocol/release";
import {
  authorizeFeedRead,
  extractFeedCredential,
  feedRefusal,
  resolveFeedPrincipal,
} from "../src/services/distribution/registry/authorize.js";
import {
  REGISTRY_SETTINGS_TTL_SECONDS,
  cachedRegistrySettings,
  d1RegistrySettings,
  forgetRegistrySettings,
  type RegistryFeed,
  type RegistrySettings,
  type RegistrySettingsSource,
} from "../src/services/distribution/registry/settings.js";
import {
  IMMUTABLE_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
  cachedRegistryAnswer,
  conditional,
  registryCacheHeaders,
  registryCacheKey,
} from "../src/services/distribution/registry/cache.js";
import {
  CONTENT_TYPE_META,
  RENDER_STAMP_META,
  SHA256_META,
  drainRegistry,
  isRenderKey,
  materialise,
  readRegistryObject,
  registryCounters,
  registryObjectKey,
  renderIsStale,
  renderRecordKey,
  renderStamp,
  renderedObjectResponse,
  selfCheck,
  type MaterialiseDeps,
  type RegistryPackage,
  type RegistryQueue,
  type RegistryQueueItem,
  type RegistryRenderer,
} from "../src/services/distribution/registry/materialise.js";
import { feedRoute } from "../src/services/distribution/registry/serve.js";
import {
  DISTRIBUTION_REGISTRY_ROUTES,
  RENDERERS,
} from "../src/services/distribution/registry/index.js";
import {
  dispatchRegistryHost,
  type RegistryEcosystem,
  type RegistryRoute,
} from "../src/core/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { deleteProduct } from "../src/admin/repo.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";

const PKG = "https://pkg.example.test";
const ON: ServicesMap = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
};

function feed(over: Partial<RegistryFeed> = {}): RegistryFeed {
  return {
    product: "djdl",
    ecosystem: "npm",
    enabled: true,
    accessMode: "public",
    namespace: { scope: "@djdl" },
    maxPackageBytes: 1 << 20,
    ext: {},
    version: 1,
    ...over,
  };
}

/** A settings source whose answers a test can change, counting its reads. */
class FakeSettings implements RegistrySettingsSource {
  reads = 0;
  value: RegistrySettings = {
    policy: { ecosystem: "npm", enabled: true, maxPackageBytesCeiling: 1 },
    owner: { product: "djdl", enabled: true },
    feed: feed(),
  };
  modes = new Map<string, ReleaseAccess>();
  async settings(): Promise<RegistrySettings> {
    this.reads++;
    return this.value;
  }
  async accessMode(_p: string, d: string): Promise<ReleaseAccess> {
    this.reads++;
    return this.modes.get(d) ?? "public";
  }
}

beforeEach(() => forgetRegistrySettings());
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { caches?: unknown }).caches;
});

// ── The extractor ────────────────────────────────────────────────────────────────────────────

describe("extractFeedCredential: the credential extractor", () => {
  const req = (authorization?: string) =>
    new Request(PKG, authorization ? { headers: { authorization } } : {});
  const b64 = (s: string) => btoa(s);

  it("parses Bearer, Basic (password or lone username) and Cargo's raw token", () => {
    expect(extractFeedCredential(req("Bearer t0k"))).toEqual({
      scheme: "bearer",
      token: "t0k",
    });
    expect(extractFeedCredential(req("bearer   t0k  "))).toEqual({
      scheme: "bearer",
      token: "t0k",
    });
    expect(extractFeedCredential(req(`Basic ${b64("user:t0k")}`))).toEqual({
      scheme: "basic",
      token: "t0k",
      username: "user",
    });
    expect(extractFeedCredential(req(`BASIC ${b64("t0k:")}`))).toEqual({
      scheme: "basic",
      token: "t0k",
    });
    // A password containing a colon is the whole rest.
    expect(extractFeedCredential(req(`Basic ${b64("u:a:b")}`))).toEqual({
      scheme: "basic",
      token: "a:b",
      username: "u",
    });
    expect(extractFeedCredential(req("pkeyci_rawtoken"))).toEqual({
      scheme: "raw",
      token: "pkeyci_rawtoken",
    });
  });

  it("parses nothing from an absent, empty, malformed or oversized header", () => {
    for (const bad of [
      undefined,
      "Bearer",
      "Bearer a b",
      `Basic ${b64(":")}`,
      `Basic ${b64("nocolon")}`,
      "Basic !!notbase64!!",
      "Basic Zg",
      "Digest username=x",
      "Bearer " + "a".repeat(9000),
    ])
      expect(extractFeedCredential(req(bad)), String(bad)).toBeNull();
    // Control characters cannot reach the parser through Headers, but a raw value with one is
    // refused too.
    const fake = {
      headers: new Map([["authorization", "Bearer a\u0001b"]]),
    } as unknown as Request;
    expect(extractFeedCredential(fake)).toBeNull();
  });

  it("resolves to anonymous when nothing it holds is a registry credential", async () => {
    for (const h of [
      undefined,
      "Bearer t",
      `Basic ${b64("u:p")}`,
      "raw",
      "junk junk",
    ])
      expect(
        await resolveFeedPrincipal(
          { db: {} as Db, services: ON },
          extractFeedCredential(req(h)),
          "djdl",
          "npm",
        ),
      ).toEqual({ kind: "anonymous" });
  });
});

// ── The ladder ───────────────────────────────────────────────────────────────────────────────

describe("authorizeFeedRead", () => {
  const db = {} as Db;
  const anon = null;
  const run = (
    s: FakeSettings,
    deliverable: string | null = "sdk",
    ecosystem: RegistryEcosystem = "npm",
    services: ServicesMap = ON,
  ) =>
    authorizeFeedRead(
      { db, services, settings: s },
      anon,
      "djdl",
      ecosystem,
      deliverable,
    );

  it("public admits anonymous with a public cache", async () => {
    expect(await run(new FakeSettings())).toEqual({
      ok: true,
      cache: "public",
    });
  });

  it("a product whose status is not active answers the not-found", async () => {
    for (const status of ["deleted", "suspended", null]) {
      const s = new FakeSettings();
      forgetRegistrySettings();
      s.value = { ...s.value, productStatus: status };
      expect(await run(s), String(status)).toEqual({
        ok: false,
        challenge: "not-found",
      });
    }
    forgetRegistrySettings();
    const active = new FakeSettings();
    active.value = { ...active.value, productStatus: "active" };
    expect((await run(active)).ok).toBe(true);
  });

  it("each step that is off (or has no row) answers the not-found", async () => {
    const cases: Array<[string, (s: FakeSettings) => void]> = [
      ["no policy row", (s) => (s.value = { ...s.value, policy: null })],
      [
        "kill switch",
        (s) =>
          (s.value = {
            ...s.value,
            policy: { ...s.value.policy!, enabled: false },
          }),
      ],
      ["no owner row", (s) => (s.value = { ...s.value, owner: null })],
      [
        "packageFeeds off",
        (s) =>
          (s.value = {
            ...s.value,
            owner: { product: "djdl", enabled: false },
          }),
      ],
      ["no feed row", (s) => (s.value = { ...s.value, feed: null })],
      [
        "feed disabled",
        (s) => (s.value = { ...s.value, feed: feed({ enabled: false }) }),
      ],
    ];
    for (const [label, mutate] of cases) {
      forgetRegistrySettings();
      const s = new FakeSettings();
      mutate(s);
      expect(await run(s), label).toEqual({
        ok: false,
        challenge: "not-found",
      });
    }
    forgetRegistrySettings();
    expect(
      await run(new FakeSettings(), "sdk", "npm", {
        ...ON,
        distribution: { enabled: false },
      }),
    ).toEqual({ ok: false, challenge: "not-found" });
  });

  it("the stricter of the feed's and the deliverable's mode decides; anything but public refuses anonymous", async () => {
    for (const mode of ["authenticated", "licensed", "entitled"] as const) {
      forgetRegistrySettings();
      const viaFeed = new FakeSettings();
      viaFeed.value = { ...viaFeed.value, feed: feed({ accessMode: mode }) };
      expect(await run(viaFeed), mode).toEqual({
        ok: false,
        challenge: "basic",
      });
      forgetRegistrySettings();
      const viaDeliverable = new FakeSettings();
      viaDeliverable.modes.set("sdk", mode);
      expect(await run(viaDeliverable), mode).toEqual({
        ok: false,
        challenge: "basic",
      });
      forgetRegistrySettings();
      expect(await run(viaDeliverable, "sdk", "oci"), mode).toEqual({
        ok: false,
        challenge: "oci-bearer",
      });
    }
  });

  it("a list document (no deliverable) counts only the feed's mode", async () => {
    const s = new FakeSettings();
    s.modes.set("sdk", "entitled");
    expect(await run(s, null)).toEqual({ ok: true, cache: "public" });
  });

  it("holds settings for the TTL, then reads again; a write on the isolate forgets them", async () => {
    const s = new FakeSettings();
    const t0 = 1_000_000;
    await cachedRegistrySettings(s, "djdl", "npm", t0);
    await cachedRegistrySettings(s, "djdl", "npm", t0 + 29_999);
    expect(s.reads).toBe(1);
    await cachedRegistrySettings(
      s,
      "djdl",
      "npm",
      t0 + REGISTRY_SETTINGS_TTL_SECONDS * 1000,
    );
    expect(s.reads).toBe(2);
    forgetRegistrySettings("djdl");
    await cachedRegistrySettings(s, "djdl", "npm", t0 + 30_001);
    expect(s.reads).toBe(3);
  });
});

const ociErrors = async (r: Response) =>
  ((await r.json()) as { errors: Array<{ code: string }> }).errors;

describe("feedRefusal", () => {
  const e = { PKG_ORIGIN: "https://pkg-dev.plrs.im" };

  it("not-found per ecosystem, never cached", async () => {
    const npm = feedRefusal("not-found", {
      env: e,
      ecosystem: "npm",
      owner: "djdl",
    });
    expect(npm.status).toBe(404);
    expect(await npm.json()).toEqual({ error: "not_found" });
    expect(npm.headers.get("cache-control")).toBe("no-store");
    const oci = feedRefusal("not-found", {
      env: e,
      ecosystem: "oci",
      owner: "djdl",
    });
    expect((await ociErrors(oci))[0]!.code).toBe("NAME_UNKNOWN");
    const swift = feedRefusal("not-found", {
      env: e,
      ecosystem: "swift",
      owner: "djdl",
    });
    expect(swift.headers.get("content-type")).toBe("application/problem+json");
  });

  it("Basic names the registry host as its realm; OCI's Bearer names the token endpoint and scope", async () => {
    const basic = feedRefusal("basic", {
      env: e,
      ecosystem: "maven",
      owner: "djdl",
    });
    expect(basic.status).toBe(401);
    expect(basic.headers.get("www-authenticate")).toBe(
      'Basic realm="pkg-dev.plrs.im"',
    );
    expect(basic.headers.get("cache-control")).toBe("no-store");
    const swift = feedRefusal("basic", {
      env: e,
      ecosystem: "swift",
      owner: "djdl",
    });
    expect(swift.headers.get("content-type")).toBe("application/problem+json");
    const oci = feedRefusal("oci-bearer", {
      env: e,
      ecosystem: "oci",
      owner: "djdl",
      repository: "game/server",
    });
    expect(oci.status).toBe(401);
    expect(oci.headers.get("www-authenticate")).toBe(
      'Bearer realm="https://pkg-dev.plrs.im/v2/token",service="pkg-dev.plrs.im",scope="repository:djdl/game/server:pull"',
    );
    expect((await ociErrors(oci))[0]!.code).toBe("UNAUTHORIZED");
    // With no PKG_ORIGIN the production name stands in.
    expect(
      feedRefusal("basic", {
        env: {},
        ecosystem: "npm",
        owner: "djdl",
      }).headers.get("www-authenticate"),
    ).toBe('Basic realm="pkg.plrs.im"');
  });
});

// ── D1 ───────────────────────────────────────────────────────────────────────────────────────

/** F-03's tables (migration 0058_d_registry.sql), dropped to model a database without them. */
const REGISTRY_TABLES = [
  "dist_registry_feeds",
  "dist_registry_owners",
  "dist_registry_policy",
];

describe("d1RegistrySettings", () => {
  it("reads missing tables as no rows, so every feed is off", async () => {
    const db = makeTestDb();
    for (const t of REGISTRY_TABLES) await db.run(`DROP TABLE ${t}`);
    const s = await d1RegistrySettings(db).settings("djdl", "npm");
    expect(s).toEqual({
      productStatus: null,
      policy: null,
      owner: null,
      feed: null,
    });
    expect(
      await authorizeFeedRead({ db, services: ON }, null, "djdl", "npm", null),
    ).toEqual({ ok: false, challenge: "not-found" });
  });

  it("an unconfigured owner on the migrated schema has the seeded policy and no owner or feed row", async () => {
    const db = makeTestDb();
    expect(await d1RegistrySettings(db).settings("djdl", "npm")).toEqual({
      productStatus: null,
      policy: {
        ecosystem: "npm",
        enabled: true,
        maxPackageBytesCeiling: 52428800,
      },
      owner: null,
      feed: null,
    });
    expect(
      await authorizeFeedRead({ db, services: ON }, null, "djdl", "npm", null),
    ).toEqual({ ok: false, challenge: "not-found" });
  });

  it("reads the plan's columns from F-03's migrated tables", async () => {
    const db = makeTestDb();
    await db.run(
      `INSERT INTO products (slug, name, signing_kid, signing_pub, compat_min, compat_max,
         default_max_offline_days, default_device_limit, created_at, modified_at)
       VALUES ('djdl', 'DJDL', 'djdl-2026', 'pub', '0.0.0', '99.0.0', 30, 5, 1, 1)`,
    );
    await db.run(
      "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES ('djdl', 1, 0)",
    );
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, ext_json, version, updated_at)
       VALUES ('djdl', 'npm', 1, 'licensed', '{"scope":"@djdl"}', 1000, '{"yankHidesFromIndex":true}', 3, 0)`,
    );
    expect(await d1RegistrySettings(db).settings("djdl", "npm")).toEqual({
      productStatus: "active",
      policy: {
        ecosystem: "npm",
        enabled: true,
        maxPackageBytesCeiling: 52428800,
      },
      owner: { product: "djdl", enabled: true },
      feed: {
        product: "djdl",
        ecosystem: "npm",
        enabled: true,
        accessMode: "licensed",
        namespace: { scope: "@djdl" },
        maxPackageBytes: 1000,
        ext: { yankHidesFromIndex: true },
        version: 3,
      },
    });
    expect(await d1RegistrySettings(db).settings("djdl", "pypi")).toMatchObject(
      { policy: { ecosystem: "pypi", enabled: true }, feed: null },
    );
    // F-30's and F-31's migrations seed Cargo's and Go's policy rows.
    expect(
      await d1RegistrySettings(db).settings("djdl", "cargo"),
    ).toMatchObject({
      policy: {
        ecosystem: "cargo",
        enabled: true,
        maxPackageBytesCeiling: 52428800,
      },
      feed: null,
    });
    expect(await d1RegistrySettings(db).settings("djdl", "go")).toMatchObject({
      policy: { ecosystem: "go", enabled: true },
      feed: null,
    });
  });

  it("deleting a product turns its packageFeeds off and stops its reads", async () => {
    const db = makeTestDb();
    await seedProduct(db, "djdl");
    await db.run(
      "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES ('djdl', 1, 0)",
    );
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, ext_json, version, updated_at)
       VALUES ('djdl', 'npm', 1, 'public', '{"scope":"@djdl"}', 1000, '{}', 1, 0)`,
    );
    const read = () =>
      authorizeFeedRead({ db, services: ON }, null, "djdl", "npm", null);
    forgetRegistrySettings();
    expect(await read()).toEqual({ ok: true, cache: "public" });
    await deleteProduct(db, "djdl", 5);
    expect(
      await db.first(
        "SELECT enabled FROM dist_registry_owners WHERE product = 'djdl'",
      ),
    ).toEqual({ enabled: 0 });
    forgetRegistrySettings();
    expect(await read()).toEqual({ ok: false, challenge: "not-found" });
    // Even with the owner row switched back on, the deleted product still serves nothing.
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 1 WHERE product = 'djdl'",
    );
    forgetRegistrySettings();
    expect(await read()).toEqual({ ok: false, challenge: "not-found" });
  });

  it("propagates any error other than a missing table", async () => {
    const broken = {
      first: async () => {
        throw new Error("D1_ERROR: network");
      },
    } as unknown as Db;
    await expect(
      d1RegistrySettings(broken).settings("djdl", "npm"),
    ).rejects.toThrow("network");
  });
});

// ── The Cache API layer ──────────────────────────────────────────────────────────────────────

/** A `caches.default` stand-in keyed by URL, counting puts. */
class FakeCache {
  store = new Map<string, Response>();
  puts = 0;
  async match(req: Request): Promise<Response | undefined> {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response): Promise<void> {
    this.puts++;
    this.store.set(req.url, res.clone());
  }
}

function installCache(): FakeCache {
  const c = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: c };
  return c;
}

describe("the Cache API layer", () => {
  it("the headers of §6.7", () => {
    const sha = "a".repeat(64);
    expect(registryCacheHeaders("public", "immutable", sha)).toEqual({
      "cache-control": IMMUTABLE_CACHE_CONTROL,
      etag: `"${sha}"`,
    });
    expect(IMMUTABLE_CACHE_CONTROL).toBe("public, max-age=31536000, immutable");
    expect(registryCacheHeaders("public", "index", sha)).toEqual({
      "cache-control": INDEX_CACHE_CONTROL,
      etag: `"${sha}"`,
    });
    expect(INDEX_CACHE_CONTROL).toBe(
      "public, max-age=60, stale-while-revalidate=60",
    );
    expect(registryCacheHeaders("private", "immutable", sha)).toEqual({
      "cache-control": "private, no-store",
    });
  });

  it("keys on the normalised path, the named query inputs and, for npm and PyPI, Accept", () => {
    const k = (
      url: string,
      eco: RegistryEcosystem,
      accept?: string,
      q?: string[],
    ) =>
      registryCacheKey(
        new Request(url, accept ? { headers: { accept } } : {}),
        eco,
        q,
      );
    expect(k(`${PKG}/npm/djdl/@djdl%2fsdk`, "npm")).toBe(
      k(`${PKG}/npm/djdl/@djdl%2Fsdk`, "npm"),
    );
    expect(k(`${PKG}/npm/djdl/x?junk=1`, "npm")).toBe(
      k(`${PKG}/npm/djdl/x`, "npm"),
    );
    expect(
      k(`${PKG}/npm/djdl/x`, "npm", "application/vnd.npm.install-v1+json"),
    ).not.toBe(k(`${PKG}/npm/djdl/x`, "npm", "application/json"));
    expect(k(`${PKG}/pypi/djdl/simple/`, "pypi", "Text/HTML")).toBe(
      k(`${PKG}/pypi/djdl/simple/`, "pypi", "text/html"),
    );
    expect(k(`${PKG}/maven/djdl/x`, "maven", "a")).toBe(
      k(`${PKG}/maven/djdl/x`, "maven", "b"),
    );
    expect(
      k(`${PKG}/v2/djdl/r/tags/list?n=5&x=1`, "oci", undefined, ["n", "last"]),
    ).toBe(`${PKG}/__pkey-registry-cache/v2/djdl/r/tags/list?n=5`);
  });

  it("stores a public 200 once and serves HEAD and If-None-Match from it; never stores a refusal", async () => {
    const cache = installCache();
    let computed = 0;
    const sha = "b".repeat(64);
    const compute = async () => {
      computed++;
      return new Response("{}", {
        headers: {
          "content-type": "application/json",
          ...registryCacheHeaders("public", "index", sha),
        },
      });
    };
    const key = `${PKG}/__pkey-registry-cache/x`;
    expect(
      (await cachedRegistryAnswer(new Request(`${PKG}/x`), key, compute))
        .status,
    ).toBe(200);
    const head = await cachedRegistryAnswer(
      new Request(`${PKG}/x`, { method: "HEAD" }),
      key,
      compute,
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const nm = await cachedRegistryAnswer(
      new Request(`${PKG}/x`, { headers: { "if-none-match": `W/"${sha}"` } }),
      key,
      compute,
    );
    expect(nm.status).toBe(304);
    expect(computed).toBe(1);
    expect(cache.puts).toBe(1);
    const refusal = async () =>
      new Response("{}", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    await cachedRegistryAnswer(
      new Request(`${PKG}/y`),
      `${PKG}/__c/y`,
      refusal,
    );
    const priv = async () =>
      new Response("{}", { headers: { "cache-control": "private, no-store" } });
    await cachedRegistryAnswer(new Request(`${PKG}/z`), `${PKG}/__c/z`, priv);
    expect(cache.puts).toBe(1);
  });

  it("a HEAD miss never stores: the following GET computes and gets the full body", async () => {
    const cache = installCache();
    const calls: string[] = [];
    const sha = "c".repeat(64);
    const answer = (method: string) => async () => {
      calls.push(method);
      // A route that answers HEAD with no body, the case that would poison the GET entry.
      return new Response(method === "HEAD" ? null : '{"full":true}', {
        headers: {
          "content-type": "application/json",
          ...registryCacheHeaders("public", "immutable", sha),
        },
      });
    };
    const key = `${PKG}/__pkey-registry-cache/h`;
    const head = await cachedRegistryAnswer(
      new Request(`${PKG}/h`, { method: "HEAD" }),
      key,
      answer("HEAD"),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(cache.puts).toBe(0);
    const get = await cachedRegistryAnswer(
      new Request(`${PKG}/h`),
      key,
      answer("GET"),
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('{"full":true}');
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(cache.puts).toBe(1);
    // A later HEAD now reads the GET entry rather than computing.
    const head2 = await cachedRegistryAnswer(
      new Request(`${PKG}/h`, { method: "HEAD" }),
      key,
      answer("HEAD"),
    );
    expect(head2.status).toBe(200);
    expect(await head2.text()).toBe("");
    expect(calls).toEqual(["HEAD", "GET"]);
    expect(cache.puts).toBe(1);
  });

  it("conditional answers 304 only for a matching ETag on a 200", () => {
    const res = () =>
      new Response("x", {
        headers: { etag: '"e"', "cache-control": "public" },
      });
    const req = (inm?: string) =>
      new Request(PKG, inm ? { headers: { "if-none-match": inm } } : {});
    expect(conditional(req('"e"'), res()).status).toBe(304);
    expect(conditional(req('"f"'), res()).status).toBe(200);
    expect(conditional(req(), res()).status).toBe(200);
  });
});

// ── Access before cache: the acceptance criterion ────────────────────────────────────────────

describe("access runs before the cache (plans/F-01.md §6.6)", () => {
  const SLUG = "djdl";
  let db: Db;
  let e: Env;

  beforeEach(async () => {
    db = makeTestDb();
    await seedProduct(db, SLUG);
    await setServices(
      db,
      SLUG,
      serializeServices({ services: ON }),
      "manifest",
      NOW,
    );
    e = makeEnv(new KvMock(), []);
    e.PKG_ORIGIN = PKG;
  });

  /** A fake npm tarball route serving immutable bytes through `serveFeedRead`. */
  function tarballRoute(
    settings: RegistrySettingsSource,
    counter: { n: number },
  ): RegistryRoute {
    return feedRoute({
      name: "fake.tarball",
      ecosystem: "npm",
      match: (p) => {
        const m = /^\/npm\/([^/]+)\/-\/(.+\.tgz)$/.exec(p);
        return m ? { owner: m[1]!, params: { file: m[2]! } } : null;
      },
      deliverableId: () => "sdk",
      settings,
      serve: async (_req, _ctx, cache) => {
        counter.n++;
        return new Response("tarball-bytes", {
          headers: {
            "content-type": "application/gzip",
            ...registryCacheHeaders(cache, "immutable", "c".repeat(64)),
          },
        });
      },
    });
  }

  const url = `${PKG}/npm/${SLUG}/-/sdk-1.0.0.tgz`;

  it("a disabled feed stops a cached immutable object within the settings TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    const cache = installCache();
    const settings = new FakeSettings();
    const counter = { n: 0 };
    const route = tarballRoute(settings, counter);
    const first = await dispatchRegistryHost(new Request(url), e, db, [route]);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(first.headers.get("content-disposition")).toBe("attachment");
    expect(await first.text()).toBe("tarball-bytes");
    expect(cache.puts).toBe(1);

    settings.value = { ...settings.value, feed: feed({ enabled: false }) };
    // Inside the window the isolate still holds the old settings, and the edge its bytes.
    vi.setSystemTime(new Date("2026-10-04T00:00:20Z"));
    expect(
      (await dispatchRegistryHost(new Request(url), e, db, [route])).status,
    ).toBe(200);
    // Past it, the not-found, although the Cache API still holds the object.
    vi.setSystemTime(new Date("2026-10-04T00:00:31Z"));
    const off = await dispatchRegistryHost(new Request(url), e, db, [route]);
    expect(off.status).toBe(404);
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await off.json()).toEqual({ error: "not_found" });
    expect(cache.store.size).toBe(1);
    expect(counter.n).toBe(1);
  });

  it("a tightened mode answers the native challenge within the TTL, uncached", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    installCache();
    const settings = new FakeSettings();
    const counter = { n: 0 };
    const route = tarballRoute(settings, counter);
    expect(
      (await dispatchRegistryHost(new Request(url), e, db, [route])).status,
    ).toBe(200);
    settings.modes.set("sdk", "licensed");
    vi.setSystemTime(new Date("2026-10-04T00:00:31Z"));
    const res = await dispatchRegistryHost(new Request(url), e, db, [route]);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Basic realm="pkg.example.test"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── The materialiser ─────────────────────────────────────────────────────────────────────────

function pkg(over: Partial<RegistryPackage> = {}): RegistryPackage {
  return {
    product: "djdl",
    ecosystem: "npm",
    deliverableId: "sdk",
    name: "@djdl/sdk",
    nameNorm: "@djdl/sdk",
    versions: [
      {
        version: "1.0.0",
        state: "live",
        stateMessage: null,
        files: [
          {
            name: "sdk-1.0.0.tgz",
            type: "npm-tarball",
            sha256: "d".repeat(64),
            size: 3,
          },
        ],
        metadata: { dependencies: {} },
        publishedAt: 1,
      },
    ],
    tags: { latest: "1.0.0" },
    ...over,
  };
}

const fakeRenderer: RegistryRenderer = {
  ecosystem: "npm",
  routes: [],
  render: (p, ctx) => [
    {
      key: `${encodeURIComponent(p.name)}/packument.json`,
      body: JSON.stringify({
        name: p.name,
        versions: p.versions.map((v) => v.version),
        origin: ctx.origin,
      }),
      contentType: "application/json",
    },
  ],
};

type TestDeps = {
  mock: R2Mock;
  bucket: R2Bucket;
  renderers: MaterialiseDeps["renderers"];
  source: MaterialiseDeps["source"];
  origin: string;
};

function deps(source: Map<string, RegistryPackage>): TestDeps {
  const mock = new R2Mock();
  return {
    mock,
    bucket: asR2(mock),
    renderers: new Map([["npm", fakeRenderer]]),
    source: { package: async (p, d) => source.get(`${p}/${d}`) ?? null },
    origin: PKG,
  };
}

describe("the materialiser", () => {
  it("every feed package's ecosystem has its renderer and routes (F-04 to F-09, F-30, F-31)", () => {
    expect([...RENDERERS.keys()].sort()).toEqual(
      ["cargo", "go", "godot", "maven", "npm", "oci", "pypi", "swift"].sort(),
    );
    for (const [ecosystem, renderer] of RENDERERS)
      expect(renderer.routes.length, ecosystem).toBeGreaterThan(0);
  });

  it("every registry route belongs to a registered renderer of its own ecosystem", () => {
    // F-02 shipped none; each feed package (F-04 to F-09) registers one renderer.
    // Every read route; F-21's credential routes (Swift's login) read no package.
    expect(
      DISTRIBUTION_REGISTRY_ROUTES.filter((r) => r.methods === undefined),
    ).toEqual([...RENDERERS.values()].flatMap((r) => r.routes));
    for (const [ecosystem, renderer] of RENDERERS) {
      expect(renderer.ecosystem).toBe(ecosystem);
      for (const route of renderer.routes) {
        expect(route.ecosystem, route.name).toBe(ecosystem);
        expect(route.service, route.name).toBe("distribution");
      }
    }
  });

  it("writes every object under registry/<ecosystem>/<owner>/ with its stamp, type and hash, then the render record", async () => {
    const d = deps(new Map([["djdl/sdk", pkg()]]));
    const r = await materialise(d, "djdl", "sdk");
    expect(r.status).toBe("rendered");
    const key = "registry/npm/djdl/%40djdl%2Fsdk/packument.json";
    expect(d.mock.keys().sort()).toEqual(
      [key, "registry/npm/djdl/.render/sdk.json"].sort(),
    );
    const obj = (await d.bucket.get(key))!;
    const stamp = await renderStamp(pkg());
    expect(obj.customMetadata).toMatchObject({
      [RENDER_STAMP_META]: stamp,
      [CONTENT_TYPE_META]: "application/json",
    });
    expect(obj.customMetadata![SHA256_META]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(await obj.text())).toEqual({
      name: "@djdl/sdk",
      versions: ["1.0.0"],
      origin: PKG,
    });
    const record = JSON.parse(
      await (await d.bucket.get(renderRecordKey("npm", "djdl", "sdk")))!.text(),
    );
    expect(record).toEqual({ stamp, keys: [key] });
    for (const k of d.mock.keys()) expect(k.startsWith("registry/")).toBe(true);
  });

  it("an absent package writes nothing; an ecosystem without a renderer writes nothing", async () => {
    const d = deps(
      new Map([["djdl/img", pkg({ ecosystem: "oci", deliverableId: "img" })]]),
    );
    expect(await materialise(d, "djdl", "nope")).toEqual({ status: "absent" });
    expect(await materialise(d, "djdl", "img")).toEqual({
      status: "no-renderer",
    });
    expect(d.mock.keys()).toEqual([]);
  });

  it("refuses keys that could escape the owner's prefix", () => {
    for (const bad of [
      "",
      "/x",
      "a//b",
      "../x",
      "a/./b",
      "a/../b",
      "a b",
      "a?b",
    ]) {
      expect(isRenderKey(bad), bad).toBe(false);
      expect(() => registryObjectKey("npm", "djdl", bad), bad).toThrow();
    }
    expect(() => registryObjectKey("npm", "../x", "a")).toThrow();
    expect(
      registryObjectKey("pypi", "djdl", "simple/polaris-key/index.json"),
    ).toBe("registry/pypi/djdl/simple/polaris-key/index.json");
  });

  it("a renderer key with a bad segment fails the render, and no record is written", async () => {
    const d = deps(new Map([["djdl/sdk", pkg()]]));
    d.renderers = new Map([
      [
        "npm",
        {
          ...fakeRenderer,
          render: () => [
            { key: "../escape", body: "x", contentType: "application/json" },
          ],
        },
      ],
    ]);
    await expect(materialise(d, "djdl", "sdk")).rejects.toThrow();
    expect(d.mock.keys()).toEqual([]);
  });

  it("renders a missing object on read, writes it back and counts the miss", async () => {
    const d = deps(new Map([["djdl/sdk", pkg()]]));
    const before = registryCounters.renderMiss;
    const ref = {
      ecosystem: "npm" as const,
      owner: "djdl",
      key: "%40djdl%2Fsdk/packument.json",
      deliverableId: "sdk",
    };
    expect(await readRegistryObject(d, ref)).not.toBeNull();
    expect(registryCounters.renderMiss).toBe(before + 1);
    expect(await readRegistryObject(d, ref)).not.toBeNull();
    expect(registryCounters.renderMiss).toBe(before + 1);
    expect(
      await readRegistryObject(d, { ...ref, key: "not/rendered.json" }),
    ).toBeNull();
    const stored = () =>
      d.bucket.get(registryObjectKey("npm", "djdl", ref.key));
    const res = renderedObjectResponse((await stored())!, "public");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(INDEX_CACHE_CONTROL);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const priv = renderedObjectResponse((await stored())!, "private");
    expect(priv.headers.get("cache-control")).toBe("private, no-store");
    expect(priv.headers.get("etag")).toBeNull();
  });

  it("the self-check re-renders only stale packages, at most the limit per run", async () => {
    const source = new Map([
      [
        "djdl/a",
        pkg({ deliverableId: "a", name: "@djdl/a", nameNorm: "@djdl/a" }),
      ],
      [
        "djdl/b",
        pkg({ deliverableId: "b", name: "@djdl/b", nameNorm: "@djdl/b" }),
      ],
      [
        "djdl/c",
        pkg({ deliverableId: "c", name: "@djdl/c", nameNorm: "@djdl/c" }),
      ],
    ]);
    const d = deps(source);
    await materialise(d, "djdl", "a");
    expect(await renderIsStale(d, "djdl", "a")).toBe(false);
    expect(await renderIsStale(d, "djdl", "b")).toBe(true);
    source.set("djdl/a", {
      ...source.get("djdl/a")!,
      tags: { latest: "1.0.0", beta: "1.0.0" },
    });
    expect(await renderIsStale(d, "djdl", "a")).toBe(true);
    const all = ["a", "b", "c"].map((x) => ({
      product: "djdl",
      deliverableId: x,
    }));
    expect(await selfCheck(d, all, 2)).toEqual(all.slice(0, 2));
    expect(await selfCheck(d, all)).toEqual([all[2]]);
    expect(await selfCheck(d, all)).toEqual([]);
  });

  it("drains the queue: one render per package, rows consumed up to its start; a failure stays queued", async () => {
    const source = new Map([["djdl/sdk", pkg()]]);
    const d = deps(source);
    const consumed: Array<[string, string, number]> = [];
    const items: RegistryQueueItem[] = [
      { product: "djdl", deliverableId: "sdk", enqueuedAt: 10 },
      { product: "djdl", deliverableId: "sdk", enqueuedAt: 11 },
      { product: "djdl", deliverableId: "broken", enqueuedAt: 12 },
    ];
    const queue: RegistryQueue = {
      pending: async () => items,
      consumed: async (p, dl, upTo) => void consumed.push([p, dl, upTo]),
    };
    d.source = {
      package: async (p, dl) => {
        if (dl === "broken") throw new Error("D1 down");
        return source.get(`${p}/${dl}`) ?? null;
      },
    };
    const out = await drainRegistry(queue, d, { now: () => 100 });
    expect(out).toEqual({ rendered: 1, failed: 1 });
    expect(consumed).toEqual([["djdl", "sdk", 100]]);
  });
});
