/**
 * F-11 — the Feeds admin API (plans/F-01.md §6.9) in both scopes, through the real admin
 * dispatcher: the overview and a feed's detail, settings writes (optimistic, validated, audited
 * `feed.settings.update`), the platform policy (`feed.policy.update` in platform_audit), the
 * packages list and record, the version verbs (`package.version.*`, `unsupported_by_ecosystem`
 * where the protocol has no such state), rebuild, the activity trail, and the platform-admin gate.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PRODUCT_SLUG } from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW, TEST_KEK, seedProduct } from "./seed.js";
import { CONSOLE, enableServices, envFor } from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import {
  FEED_CAPABILITIES,
  feedBaseUrl,
  parseNamespace,
  verbSupported,
} from "../src/admin/lib/feedModel.js";

let db: Db;
let env: Env;

const OWNER = "acme";

beforeEach(async () => {
  db = makeTestDb();
  env = envFor({ kv: new KvMock() });
  env.PLATFORM_KEK = TEST_KEK;
  env.PKG_ORIGIN = "https://pkg.plrs.im";
  await seedProduct(db, OWNER);
  await enableServices(db, true, OWNER);
});

/** A response whose JSON body the assertions read loosely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
interface JsonResponse extends Response {
  json(): Promise<Loose>;
}

async function admin(
  method: string,
  path: string,
  body?: unknown,
  groups = ["platform-admins"],
): Promise<JsonResponse> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups },
    NOW,
  );
  const full = `/api${path}`;
  return (await handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full.split("?")[0]!,
    { now: NOW },
  )) as JsonResponse;
}

const product = (rest = "") => `/products/${OWNER}/distribution/feeds${rest}`;

async function turnOnPackageFeeds(slug = OWNER): Promise<void> {
  const res = await admin(
    "PUT",
    `/products/${slug}/distribution/package-feeds`,
    {
      enabled: true,
      expectedVersion: 0,
    },
  );
  expect(res.status).toBe(200);
}

/** A package deliverable and its versions, written as F-03's ingest leaves them. */
async function seedPackage(
  slug: string,
  ecosystem: string,
  deliverableId: string,
  name: string,
  versions: { version: string; state?: string; at: number; channel?: string }[],
): Promise<void> {
  await db.run(
    `INSERT INTO release_deliverables
       (product, deliverable_id, kind, def_source, created_at, modified_at, ecosystem, package_name)
     VALUES (?, ?, 'package', 'manifest', ?, ?, ?, ?)`,
    slug,
    deliverableId,
    NOW,
    NOW,
    ecosystem,
    name,
  );
  let seq = 1;
  for (const v of versions) {
    const releaseId = `${deliverableId}@${v.version}`;
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, published_at, created_at, modified_at, deliverable_id,
          seq, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      slug,
      releaseId,
      v.version,
      v.at,
      v.at,
      v.at,
      deliverableId,
      seq++,
      v.channel ?? "stable",
    );
    await db.run(
      `INSERT INTO release_packages
         (product, ecosystem, name_norm, version, deliverable_id, release_id, name, state,
          files_json, metadata_json, source_json, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      slug,
      ecosystem,
      name.toLowerCase(),
      v.version,
      deliverableId,
      releaseId,
      name,
      v.state ?? "live",
      JSON.stringify([
        {
          name: `pkg-${v.version}.tgz`,
          type: "npm-tarball",
          sha256: "a".repeat(64),
          size: 1200,
          sha512: "b".repeat(128),
        },
      ]),
      JSON.stringify({
        kind: "oidc",
        publisher: "github:acme/sdk",
        runUrl: "https://github.com/acme/sdk/actions/runs/1",
      }),
      v.at,
    );
  }
}

async function auditActions(slug: string): Promise<string[]> {
  return (
    await db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = ? ORDER BY at, id",
      slug,
    )
  ).map((r) => r.action);
}

describe("the feed model", () => {
  it("refuses only the verbs a protocol has no state for", () => {
    expect(verbSupported("npm", "yank")).toBe(false);
    expect(verbSupported("npm", "deprecate")).toBe(true);
    expect(verbSupported("pypi", "yank")).toBe(true);
    expect(verbSupported("pypi", "deprecate")).toBe(false);
    expect(FEED_CAPABILITIES.maven.yankPolicy).toBe(true);
  });

  it("builds each feed's base URL on the registry host", () => {
    const o = "https://pkg.plrs.im";
    expect(feedBaseUrl(o, "npm", "acme")).toBe("https://pkg.plrs.im/npm/acme/");
    expect(feedBaseUrl(o, "pypi", "acme")).toBe(
      "https://pkg.plrs.im/pypi/acme/simple/",
    );
    expect(feedBaseUrl(o, "oci", "acme")).toBe("https://pkg.plrs.im/v2/acme/");
    expect(feedBaseUrl(null, "npm", "acme")).toBeNull();
  });

  it("validates namespaces per ecosystem and refuses unknown keys", () => {
    expect(parseNamespace("npm", { scope: "@acme" })).toEqual({
      scope: "@acme",
    });
    expect(parseNamespace("npm", { scope: "acme" })).toBeNull();
    expect(parseNamespace("npm", { scop: "@acme" })).toBeNull();
    expect(
      parseNamespace("maven", { groupPrefixes: ["gg.acme", "gg.acme"] }),
    ).toEqual({ groupPrefixes: ["gg.acme"] });
    expect(parseNamespace("oci", {})).toEqual({});
    expect(parseNamespace("godot", { publisher: "" })).toEqual({});
  });
});

describe("product scope", () => {
  it("lists every ecosystem with its status, from not set up to enabled", async () => {
    let res = await admin("GET", product());
    expect(res.status).toBe(200);
    let body = (await res.json()) as {
      owner: string;
      feeds: { ecosystem: string; status: string; reason: string | null }[];
    };
    expect(body.owner).toBe(OWNER);
    expect(body.feeds.map((f) => f.ecosystem)).toEqual([
      "npm",
      "pypi",
      "swift",
      "maven",
      "oci",
      "godot",
      "cargo",
    ]);
    expect(body.feeds[0]).toMatchObject({
      status: "off",
      reason: "package-feeds-off",
    });

    await turnOnPackageFeeds();
    res = await admin("PUT", product("/npm/settings"), {
      expectedVersion: 0,
      enabled: true,
      namespace: { scope: "@acme" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settings: { enabled: true, namespace: { scope: "@acme" }, version: 1 },
    });
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", [
      { version: "1.0.0", at: NOW - 100 },
      { version: "1.1.0", at: NOW - 10 },
    ]);
    body = await (await admin("GET", product())).json();
    expect(body.feeds[0]).toMatchObject({
      ecosystem: "npm",
      status: "enabled",
      packages: 1,
      versions: 2,
      lastPublishedAt: NOW - 10,
      baseUrl: "https://pkg.plrs.im/npm/acme/",
    });
    expect(body.feeds[1]).toMatchObject({
      status: "off",
      reason: "not-set-up",
    });
    expect((body as unknown as { summary: unknown }).summary).toEqual({
      feedsEnabled: 1,
      packages: 1,
      versions: 2,
      lastPublishedAt: NOW - 10,
    });
  });

  it("reads one feed: settings at version 0 before the first save, the policy and capabilities", async () => {
    const res = await admin("GET", product("/pypi"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      feed: { ecosystem: "pypi", configured: false },
      settings: {
        enabled: false,
        accessMode: "public",
        version: 0,
        maxPackageBytes: 52428800,
      },
      policy: { enabled: true, maxPackageBytesCeiling: 52428800 },
      capabilities: { yank: true, deprecate: false },
      // F-12: the extension settings the ecosystem panel renders, from the adapter.
      extensions: ["htmlFallback"],
      accessModes: [
        { mode: "public", available: true },
        { mode: "authenticated", available: true },
        { mode: "licensed", available: true },
        { mode: "entitled", available: true },
      ],
    });
    expect((await admin("GET", product("/go"))).status).toBe(404);
  });

  it("validates settings writes: namespace, ceiling, access mode, upstream, unknown fields", async () => {
    const put = (body: unknown) => admin("PUT", product("/npm/settings"), body);
    let res = await put({ expectedVersion: 0, enabled: true });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "namespace_required" },
    });
    res = await put({
      expectedVersion: 0,
      namespace: { scope: "@acme" },
      accessMode: "private",
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "access_mode_unavailable", fields: ["accessMode"] },
    });
    res = await put({ expectedVersion: 0, maxPackageBytes: 52428801 });
    expect(await res.json()).toMatchObject({
      error: { fields: ["maxPackageBytes"] },
    });
    res = await put({ expectedVersion: 0, upstream: "npmjs" });
    expect(await res.json()).toMatchObject({ error: { fields: ["upstream"] } });
    res = await put({ expectedVersion: 0, ext: { requireSigned: true } });
    expect(await res.json()).toMatchObject({
      error: { fields: ["ext.requireSigned"] },
    });
    res = await put({ expectedVersion: 0, claims: [] });
    expect(await res.json()).toMatchObject({ error: { fields: ["claims"] } });
    expect(await auditActions(OWNER)).toEqual([]);
  });

  it("validates each ecosystem panel's extension settings against its adapter (F-12)", async () => {
    const swift = (ext: unknown) =>
      admin("PUT", product("/swift/settings"), { expectedVersion: 0, ext });
    let res = await swift({
      requireSigned: false,
      repositoryUrls: {
        "acme.Kit": [
          "https://github.com/acme/kit.git",
          "git@github.com:acme/kit",
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settings: {
        version: 1,
        ext: {
          requireSigned: false,
          repositoryUrls: {
            "acme.Kit": [
              "https://github.com/acme/kit.git",
              "git@github.com:acme/kit",
            ],
          },
        },
      },
    });
    res = await admin("PUT", product("/swift/settings"), {
      expectedVersion: 1,
      ext: { repositoryUrls: { "not an id": ["https://x.test/a"] } },
    });
    expect(await res.json()).toMatchObject({
      error: { fields: ["ext.repositoryUrls"] },
    });
    res = await admin("PUT", product("/godot/settings"), {
      expectedVersion: 0,
      ext: {
        categoryId: 3,
        supportLevel: "testing",
        license: "MIT",
        minGodotVersion: "4.4",
      },
    });
    expect(res.status).toBe(200);
    res = await admin("PUT", product("/godot/settings"), {
      expectedVersion: 1,
      ext: { minGodotVersion: "four" },
    });
    expect(await res.json()).toMatchObject({
      error: { fields: ["ext.minGodotVersion"] },
    });
    const detail = (await (await admin("GET", product("/godot"))).json()) as {
      extensions: string[];
    };
    expect(detail.extensions).toEqual([
      "categoryId",
      "supportLevel",
      "license",
      "minGodotVersion",
    ]);
  });

  it("is optimistic: a stale expectedVersion is a 409 with the current settings", async () => {
    const put = (body: unknown) =>
      admin("PUT", product("/maven/settings"), body);
    expect(
      (
        await put({
          expectedVersion: 0,
          namespace: { groupPrefixes: ["gg.acme"] },
        })
      ).status,
    ).toBe(200);
    const stale = await put({ expectedVersion: 0, enabled: false });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { reason: "version_conflict", settings: { version: 1 } },
    });
    const ok = await put({
      expectedVersion: 1,
      enabled: true,
      ext: { yankHidesFromIndex: true },
      maxPackageBytes: 1000,
    });
    expect(await ok.json()).toMatchObject({
      settings: {
        enabled: true,
        version: 2,
        maxPackageBytes: 1000,
        ext: { yankHidesFromIndex: true },
      },
    });
    expect(await auditActions(OWNER)).toEqual([
      "feed.settings.update",
      "feed.settings.update",
    ]);
    const target = await db.first(
      "SELECT target_kind, target_id, summary FROM audit WHERE product = ? ORDER BY at DESC, id DESC",
      OWNER,
    );
    expect(target).toMatchObject({ target_kind: "feed", target_id: "maven" });
    expect(
      await db.all(
        "SELECT deliverable_id, reason FROM registry_render_queue WHERE product = ?",
        OWNER,
      ),
    ).toEqual([{ deliverable_id: "*", reason: "settings" }]);
  });

  it("has no policy route: the platform policy is the platform's", async () => {
    expect(
      (await admin("PUT", product("/npm/policy"), { expectedVersion: 1 }))
        .status,
    ).toBe(404);
  });

  it("lists packages and reads one with its versions, tags, sources and digests", async () => {
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", [
      { version: "1.0.0", at: NOW - 100 },
      { version: "1.1.0", at: NOW - 10, state: "deprecated" },
    ]);
    await seedPackage(OWNER, "npm", "npm.cli", "@acme/cli", [
      { version: "0.1.0", at: NOW - 50 },
    ]);
    const list = await admin("GET", product("/npm/packages"));
    expect(list.status).toBe(200);
    const page = (await list.json()) as {
      items: { name: string; owner: string; latestVersion: string }[];
      nextCursor: string | null;
    };
    expect(page.items.map((i) => i.name)).toEqual(["@acme/cli", "@acme/sdk"]);
    expect(page.items[1]).toMatchObject({
      owner: OWNER,
      latestVersion: "1.1.0",
      versions: 2,
    });
    expect(page.nextCursor).toBeNull();
    const searched = await (
      await admin("GET", product("/npm/packages?q=cli"))
    ).json();
    expect(searched.items.map((i: { name: string }) => i.name)).toEqual([
      "@acme/cli",
    ]);
    const paged = await (
      await admin("GET", product("/npm/packages?limit=1"))
    ).json();
    expect(paged.nextCursor).toBe("1");

    const rec = await admin(
      "GET",
      product(`/npm/packages/${encodeURIComponent("@acme/sdk")}`),
    );
    expect(rec.status).toBe(200);
    const record = (await rec.json()) as {
      versions: Record<string, unknown>[];
    };
    expect(record).toMatchObject({
      owner: OWNER,
      ecosystem: "npm",
      name: "@acme/sdk",
      deliverableId: "npm.sdk",
      baseUrl: "https://pkg.plrs.im/npm/acme/",
      capabilities: { yank: false, deprecate: true },
    });
    expect(record.versions.map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(record.versions[0]).toMatchObject({
      state: "deprecated",
      size: 1200,
      source: {
        kind: "oidc",
        publisher: "github:acme/sdk",
        runUrl: "https://github.com/acme/sdk/actions/runs/1",
      },
      files: [{ sha256: "a".repeat(64), sha512: "b".repeat(128) }],
    });
    expect(
      (await admin("GET", product("/npm/packages/%40acme%2Fnope"))).status,
    ).toBe(404);
  });

  it("yanks, unyanks and deprecates through Release, audited package.version.*, refusing what the protocol lacks", async () => {
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", [
      { version: "1.0.0", at: NOW - 100 },
    ]);
    await seedPackage(OWNER, "pypi", "py.sdk", "acme-sdk", [
      { version: "2.0.0", at: NOW - 100 },
    ]);
    const npm = (verb: string, body?: unknown) =>
      admin(
        "POST",
        product(`/npm/packages/%40acme%2Fsdk/versions/1.0.0/${verb}`),
        body,
      );
    const py = (verb: string, body?: unknown) =>
      admin(
        "POST",
        product(`/pypi/packages/acme-sdk/versions/2.0.0/${verb}`),
        body,
      );

    let res = await npm("yank", { reason: "broken" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { reason: "unsupported_by_ecosystem" },
    });
    expect((await py("deprecate", { message: "x" })).status).toBe(422);

    res = await npm("deprecate", { message: "use 2.x" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "deprecated" });
    res = await npm("undeprecate");
    expect(await res.json()).toEqual({ ok: true, state: "live" });

    expect((await py("yank", {})).status).toBe(422);
    res = await py("yank", { reason: "bad wheel" });
    expect(await res.json()).toEqual({ ok: true, state: "yanked" });
    expect(
      await db.first(
        "SELECT state, state_message FROM release_packages WHERE product = ? AND version = '2.0.0'",
        OWNER,
      ),
    ).toEqual({ state: "yanked", state_message: "bad wheel" });
    res = await py("unyank");
    expect(await res.json()).toEqual({ ok: true, state: "live" });
    expect((await py("unyank")).status).toBe(404);
    expect(
      (
        await admin(
          "POST",
          product("/pypi/packages/acme-sdk/versions/9.9.9/yank"),
          { reason: "x" },
        )
      ).status,
    ).toBe(404);

    const rows = await db.all<{
      action: string;
      target_kind: string;
      target_id: string;
    }>(
      "SELECT action, target_kind, target_id FROM audit WHERE product = ? ORDER BY at, rowid",
      OWNER,
    );
    expect(rows).toEqual([
      {
        action: "package.version.deprecate",
        target_kind: "package",
        target_id: "npm:@acme/sdk@1.0.0",
      },
      {
        action: "package.version.undeprecate",
        target_kind: "package",
        target_id: "npm:@acme/sdk@1.0.0",
      },
      {
        action: "package.version.yank",
        target_kind: "package",
        target_id: "pypi:acme-sdk@2.0.0",
      },
      {
        action: "package.version.unyank",
        target_kind: "package",
        target_id: "pypi:acme-sdk@2.0.0",
      },
    ]);

    // The feed's activity is its settings and its versions' verbs, nothing else of the product.
    const act = await (await admin("GET", product("/pypi/activity"))).json();
    expect(act.items.map((i: { action: string }) => i.action).sort()).toEqual([
      "package.version.unyank",
      "package.version.yank",
    ]);
  });

  it("rebuilds: every package of the ecosystem is queued, audited feed.rebuild", async () => {
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", []);
    await seedPackage(OWNER, "npm", "npm.cli", "@acme/cli", []);
    const res = await admin("POST", product("/npm/rebuild"));
    expect(await res.json()).toEqual({ ok: true, queued: 2 });
    expect(
      (
        await db.all<{ deliverable_id: string }>(
          "SELECT deliverable_id FROM registry_render_queue WHERE product = ? ORDER BY deliverable_id",
          OWNER,
        )
      ).map((r) => r.deliverable_id),
    ).toEqual(["npm.cli", "npm.sdk"]);
    expect(await auditActions(OWNER)).toEqual(["feed.rebuild"]);
  });

  it("is 404 for an unknown product, and 403 for a non-admin", async () => {
    expect(
      (await admin("GET", "/products/nope/distribution/feeds")).status,
    ).toBe(404);
    expect((await admin("GET", product(), undefined, ["staff"])).status).toBe(
      403,
    );
  });

  it("carries packageFeeds on the product row the shell reads", async () => {
    let row = await (await admin("GET", `/products/${OWNER}`)).json();
    expect(row.product.packageFeeds).toBe(false);
    await turnOnPackageFeeds();
    row = await (await admin("GET", `/products/${OWNER}`)).json();
    expect(row.product.packageFeeds).toBe(true);
  });
});

describe("platform scope", () => {
  const platform = (rest = "") => `/platform/feeds${rest}`;

  it("before the bootstrap: no owner, every feed off, settings refused", async () => {
    const body = await (await admin("GET", platform())).json();
    expect(body).toMatchObject({ scope: "platform", owner: null });
    expect(body.feeds[0]).toMatchObject({ status: "off", reason: "no-owner" });
    const res = await admin("PUT", platform("/npm/settings"), {
      expectedVersion: 0,
      enabled: false,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { reason: "system_product_missing" },
    });
  });

  it("after the bootstrap: the system product's feeds, every owner, and its packages", async () => {
    expect((await admin("POST", platform("/bootstrap"))).status).toBe(200);
    await turnOnPackageFeeds();
    await seedPackage(
      SYSTEM_PRODUCT_SLUG,
      "npm",
      "npm.node",
      "@polaris-key/node",
      [{ version: "0.9.0", at: NOW - 5 }],
    );
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", [
      { version: "1.0.0", at: NOW - 100 },
    ]);
    const body = await (await admin("GET", platform())).json();
    expect(body).toMatchObject({ owner: SYSTEM_PRODUCT_SLUG });
    expect(
      body.feeds.every((f: { status: string }) => f.status === "enabled"),
    ).toBe(true);
    expect(body.feeds[0]).toMatchObject({
      packages: 1,
      baseUrl: "https://pkg.plrs.im/npm/polaris-key/",
    });
    expect(body.owners).toEqual([
      {
        slug: SYSTEM_PRODUCT_SLUG,
        name: "Polaris Key",
        system: true,
        packageFeeds: true,
      },
      { slug: OWNER, name: OWNER, system: false, packageFeeds: true },
    ]);
    // The system product's feeds are reachable only from Platform, never as a product scope.
    for (const path of ["", "/npm", "/npm/packages"])
      expect(
        (
          await admin(
            "GET",
            `/products/${SYSTEM_PRODUCT_SLUG}/distribution/feeds${path}`,
          )
        ).status,
        path,
      ).toBe(404);
    // Every owner by default; `owner` narrows.
    const all = await (await admin("GET", platform("/npm/packages"))).json();
    expect(all.items.map((i: { owner: string }) => i.owner)).toEqual([
      OWNER,
      SYSTEM_PRODUCT_SLUG,
    ]);
    const mine = await (
      await admin("GET", platform(`/npm/packages?owner=${SYSTEM_PRODUCT_SLUG}`))
    ).json();
    expect(mine.items.map((i: { name: string }) => i.name)).toEqual([
      "@polaris-key/node",
    ]);
    const rec = await admin(
      "GET",
      platform(`/npm/packages/${OWNER}/${encodeURIComponent("@acme/sdk")}`),
    );
    expect(rec.status).toBe(200);
    expect(await rec.json()).toMatchObject({ owner: OWNER, name: "@acme/sdk" });
  });

  it("settings write the system product's feed, audited under it", async () => {
    await admin("POST", platform("/bootstrap"));
    const detail = await (await admin("GET", platform("/godot"))).json();
    expect(detail.settings).toMatchObject({
      enabled: true,
      namespace: { publisher: "polaris-key" },
      version: 1,
    });
    const res = await admin("PUT", platform("/godot/settings"), {
      expectedVersion: 1,
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await auditActions(SYSTEM_PRODUCT_SLUG)).toEqual([
      "feed.settings.update",
    ]);
  });

  it("the policy: kill switch and ceiling, optimistic, audited in platform_audit", async () => {
    const before = await (await admin("GET", platform("/oci"))).json();
    expect(before.policy).toMatchObject({
      enabled: true,
      maxPackageBytesCeiling: 5368709120,
      version: 1,
    });
    let res = await admin("PUT", platform("/oci/policy"), {
      expectedVersion: 1,
      enabled: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      policy: { enabled: false, version: 2 },
    });
    res = await admin("PUT", platform("/oci/policy"), {
      expectedVersion: 1,
      enabled: true,
    });
    expect(res.status).toBe(409);
    res = await admin("PUT", platform("/oci/policy"), {
      expectedVersion: 2,
      maxPackageBytesCeiling: 10,
    });
    expect(res.status).toBe(422);
    const overview = await (await admin("GET", platform())).json();
    expect(
      overview.feeds.find((f: { ecosystem: string }) => f.ecosystem === "oci"),
    ).toMatchObject({ status: "unavailable", reason: "platform-off" });
    expect(
      await db.all("SELECT action, target_id FROM platform_audit"),
    ).toEqual([{ action: "feed.policy.update", target_id: "oci" }]);
    const act = await (await admin("GET", platform("/oci/activity"))).json();
    expect(act.items.map((i: { action: string }) => i.action)).toEqual([
      "feed.policy.update",
    ]);
  });

  it("is platform-admin only", async () => {
    expect((await admin("GET", platform(), undefined, ["staff"])).status).toBe(
      403,
    );
  });
});

describe("registry tokens and the access switch (F-21, plans/F-20.md §6.5)", () => {
  const tokens = (rest = "") => product(`/tokens${rest}`);
  const platform = (rest = "") => `/platform/feeds${rest}`;

  it("mints, lists, revokes and revokes all; the plaintext is in the mint answer only, every write audited", async () => {
    let res = await admin("POST", tokens(), {
      label: "CI pull",
      binding: "owner",
      ecosystems: ["npm", "oci"],
      expiresInDays: 30,
    });
    expect(res.status).toBe(201);
    const minted = await res.json();
    expect(minted.token).toMatch(/^pkeyr_[A-Za-z0-9_-]{43}$/);
    expect(minted.view).toMatchObject({
      label: "CI pull",
      binding: "owner",
      ecosystems: ["npm", "oci"],
      presentation: "header",
      status: "active",
      expiresAt: NOW + 30 * 86_400,
      createdBy: "admin:ada@x.io",
    });
    await admin("POST", tokens(), {
      label: "Editor",
      binding: "owner",
      presentation: "url",
    });
    res = await admin("GET", tokens());
    expect(res.status).toBe(200);
    const listed = await res.json();
    expect(listed.tokens.map((t: { label: string }) => t.label).sort()).toEqual(
      ["CI pull", "Editor"],
    );
    expect(JSON.stringify(listed)).not.toContain(minted.token);
    expect(listed.username).toBe("__token__");
    expect(listed.feeds).toHaveLength(7);
    expect(listed.limits).toMatchObject({
      defaultDays: 90,
      urlDefaultDays: 30,
    });
    res = await admin("POST", tokens(`/${minted.view.tokenId}/revoke`));
    expect((await res.json()).view.status).toBe("revoked");
    expect((await admin("POST", tokens("/rtok_nope/revoke"))).status).toBe(404);
    res = await admin("POST", tokens("/revoke-all"), {});
    expect((await res.json()).revoked).toBe(1);
    expect(
      (
        await db.all<{ action: string }>(
          "SELECT action FROM audit WHERE product = ? AND action LIKE 'registry_token.%' ORDER BY at, id",
          OWNER,
        )
      )
        .map((r) => r.action)
        .sort(),
    ).toEqual(
      [
        "registry_token.create",
        "registry_token.create",
        "registry_token.revoke",
        "registry_token.revoke_all",
      ].sort(),
    );
  });

  it("refuses bad input and narrows to one licence", async () => {
    expect(
      (
        await admin("POST", tokens(), {
          label: "x",
          binding: "owner",
          expiresInDays: 400,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("POST", tokens(), {
          label: "x",
          binding: "owner",
          secret: 1,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin("POST", tokens(), {
          label: "x",
          binding: "license",
          licenseId: "lic_x",
        })
      ).status,
    ).toBe(404);
    await db.run(
      `INSERT INTO licenses (product, id, status, activated_at, modified_at) VALUES (?, 'lic_1', 'active', ?, ?)`,
      OWNER,
      NOW,
      NOW,
    );
    expect(
      (
        await admin("POST", tokens(), {
          label: "seat",
          binding: "license",
          licenseId: "lic_1",
        })
      ).status,
    ).toBe(201);
    await admin("POST", tokens(), { label: "owner", binding: "owner" });
    const one = await (await admin("GET", tokens("?license=lic_1"))).json();
    expect(one.tokens.map((t: { label: string }) => t.label)).toEqual(["seat"]);
    expect(
      (
        await (
          await admin("POST", tokens("/revoke-all"), { licenseId: "lic_1" })
        ).json()
      ).revoked,
    ).toBe(1);
  });

  it("every access mode can be set, and the feed lists the packages entitled would refuse", async () => {
    await turnOnPackageFeeds();
    await seedPackage(OWNER, "npm", "npm.sdk", "@acme/sdk", [
      { version: "1.0.0", at: NOW },
    ]);
    let res = await admin("PUT", product("/npm/settings"), {
      expectedVersion: 0,
      enabled: true,
      namespace: { scope: "@acme" },
      accessMode: "licensed",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).settings.accessMode).toBe("licensed");
    const detail = await (await admin("GET", product("/npm"))).json();
    expect(detail.ungatedPackages).toEqual([
      { id: "npm.sdk", name: "@acme/sdk" },
    ]);
    res = await admin("PUT", product("/npm/settings"), {
      expectedVersion: 1,
      accessMode: "entitled",
    });
    expect(res.status).toBe(200);
  });

  it("the platform's tokens live under the platform scope and audit to platform_audit", async () => {
    expect((await admin("GET", platform("/tokens"))).status).toBe(409);
    expect((await admin("POST", platform("/bootstrap"))).status).toBe(200);
    const res = await admin("POST", platform("/tokens"), {
      label: "mirror",
      binding: "owner",
    });
    expect(res.status).toBe(201);
    expect(
      await db.all(
        "SELECT action FROM platform_audit WHERE action LIKE 'registry_token.%'",
      ),
    ).toEqual([{ action: "registry_token.create" }]);
    // The system product's access mode cannot change from a product scope.
    const sys = `/products/${SYSTEM_PRODUCT_SLUG}/distribution/feeds/npm/settings`;
    const put = await admin("PUT", sys, {
      expectedVersion: 1,
      accessMode: "licensed",
    });
    expect([403, 404]).toContain(put.status);
  });
});
