/**
 * The npm feed (F-04, plans/F-01.md §6.7 and §6.8).
 *
 *   - THE DOCUMENTS: the full and abbreviated packuments of a fixture with a stable, a beta, a
 *     yanked and a deprecated version, compared against golden files under
 *     `test/fixtures/registry/npm/` (`UPDATE_NPM_GOLDENS=1` rewrites them);
 *   - NEGOTIATION and DIST-TAGS as pure functions;
 *   - THE ROUTES end to end: packages published through the real submit route, yanked and
 *     deprecated through the real admin API, read through the real registry host dispatcher
 *     (`dispatchRegistryHost` over `mount.ts`'s `REGISTRY_ROUTES`): both `%2f` spellings, Accept
 *     negotiation, the §6.7 headers, tarball bytes against `dist.integrity`, yank and deprecate
 *     behaviour, scope enforcement, the access ladder and re-rendering after a change.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { NOW } from "../seed.js";
import { asR2, installDigestStream, R2Mock } from "../r2Mock.js";
import {
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "../releaseRoutesFixture.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import type { FetchImpl } from "../../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../../src/core/publisher.js";
import { manifestDeliverableStatements } from "../../src/services/release/deliverables.js";
import { handleAdmin } from "../../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../../src/admin/session.js";
import { dispatchRegistryHost } from "../../src/core/registryHost.js";
import { REGISTRY_ROUTES, SERVICES } from "../../src/mount.js";
import {
  INDEX_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
} from "../../src/services/distribution/registry/cache.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  RENDER_STAMP_META,
  registryCounters,
  type RegistryPackage,
} from "../../src/services/distribution/registry/materialise.js";
import {
  DEPRECATED_MESSAGE,
  NPM_ABBREVIATED_TYPE,
  YANKED_MESSAGE,
  distTags,
  packuments,
  renderNpm,
  tarballUrl,
} from "../../src/services/distribution/registry/npm/render.js";
import { wantsAbbreviated } from "../../src/services/distribution/registry/npm/routes.js";
import { channelTag } from "../../src/services/distribution/registry/catalogSource.js";

installDigestStream();

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(here, "..", "fixtures", "registry", "npm");
const PKG = "https://pkg.example.test";

function golden(name: string, value: unknown): void {
  const file = join(GOLDEN_DIR, name);
  if (process.env.UPDATE_NPM_GOLDENS === "1") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  // Compared as compact JSON, so key order counts and the file's formatting (prettier) does not.
  expect(JSON.stringify(value), `${name} differs from its golden file`).toBe(
    JSON.stringify(JSON.parse(readFileSync(file, "utf8"))),
  );
}

const sha = (b: Uint8Array | string, alg = "sha256") =>
  createHash(alg).update(b).digest("hex");
const sri512 = (b: Uint8Array) =>
  `sha512-${createHash("sha512").update(b).digest("base64")}`;

// ── The documents ────────────────────────────────────────────────────────────────────────────

/** The fixture: 0.9.0 deprecated, 1.0.0 stable, 1.1.0 yanked, 1.2.0-beta.1 on beta. */
function fixture(over: Partial<RegistryPackage> = {}): RegistryPackage {
  const file = (v: string, digests = true) => ({
    name: `acme-sdk-${v}.tgz`,
    type: "npm-tarball",
    sha256: sha(`tgz ${v}`),
    size: 100 + v.length,
    ...(digests
      ? { sha512: sha(`tgz ${v}`, "sha512"), sha1: sha(`tgz ${v}`, "sha1") }
      : {}),
  });
  const meta = (v: string, extra: Record<string, unknown> = {}) => ({
    name: "@acme/sdk",
    version: v,
    description: `The Acme SDK ${v}`,
    license: "MIT",
    dependencies: { "@acme/core": "^1.0.0" },
    engines: { node: ">=18" },
    exports: { ".": "./index.js" },
    ...extra,
  });
  return {
    product: "acme",
    ecosystem: "npm",
    deliverableId: "npm.sdk",
    name: "@acme/sdk",
    nameNorm: "@acme/sdk",
    versions: [
      {
        version: "0.9.0",
        state: "deprecated",
        stateMessage: "use 1.x",
        files: [file("0.9.0")],
        metadata: meta("0.9.0"),
        publishedAt: 1_790_000_000,
      },
      {
        version: "1.0.0",
        state: "live",
        stateMessage: null,
        files: [file("1.0.0")],
        metadata: meta("1.0.0", {
          bin: { acme: "./cli.js" },
          os: ["darwin", "linux"],
          cpu: ["arm64", "x64"],
          peerDependencies: { react: ">=18" },
          optionalDependencies: { fsevents: "^2.3.0" },
          devDependencies: { vitest: "^3.0.0" },
          keywords: ["acme"],
          // Not on the allowlist: never rendered.
          scripts: { postinstall: "curl evil" },
          version: "6.6.6",
          name: "@evil/other",
        }),
        publishedAt: 1_790_000_100,
      },
      {
        version: "1.1.0",
        state: "yanked",
        stateMessage: "broken build",
        files: [file("1.1.0")],
        metadata: meta("1.1.0"),
        publishedAt: 1_790_000_200,
      },
      {
        version: "1.2.0-beta.1",
        state: "live",
        stateMessage: null,
        // Digests missing (a failed digest read at ingest): integrity falls back to SHA-256.
        files: [file("1.2.0-beta.1", false)],
        metadata: meta("1.2.0-beta.1"),
        publishedAt: 1_790_000_300,
      },
    ],
    tags: { latest: "1.0.0", beta: "1.2.0-beta.1" },
    ...over,
  };
}

describe("npm documents (golden files)", () => {
  it("renders the full packument", () => {
    golden("packument.full.json", packuments(fixture(), { origin: PKG }).full);
  });

  it("renders the abbreviated packument", () => {
    golden(
      "packument.abbreviated.json",
      packuments(fixture(), { origin: PKG }).abbreviated,
    );
  });

  it("writes both documents under the package's normalised name with their types", () => {
    const objs = renderNpm(fixture(), { origin: PKG });
    expect(objs.map((o) => [o.key, o.contentType])).toEqual([
      ["@acme/sdk/full.json", "application/json"],
      ["@acme/sdk/abbreviated.json", NPM_ABBREVIATED_TYPE],
    ]);
  });

  it("dist: SRI SHA-512 and SHA-1 from the ingest digests, SHA-256 as the fallback, an absolute conventional tarball URL", () => {
    const { full } = packuments(fixture(), { origin: PKG });
    const versions = full.versions as Record<string, any>;
    expect(versions["1.0.0"].dist).toEqual({
      integrity: `sha512-${Buffer.from(sha("tgz 1.0.0", "sha512"), "hex").toString("base64")}`,
      shasum: sha("tgz 1.0.0", "sha1"),
      tarball: `${PKG}/npm/acme/@acme/sdk/-/sdk-1.0.0.tgz`,
    });
    expect(versions["1.2.0-beta.1"].dist).toEqual({
      integrity: `sha256-${Buffer.from(sha("tgz 1.2.0-beta.1"), "hex").toString("base64")}`,
      tarball: `${PKG}/npm/acme/@acme/sdk/-/sdk-1.2.0-beta.1.tgz`,
    });
  });

  it("a yanked version stays listed with a deprecation and leaves every dist-tag; a deprecated one carries its message", () => {
    const { full, abbreviated } = packuments(
      fixture({ tags: { latest: "1.1.0", beta: "1.2.0-beta.1" } }),
      { origin: PKG },
    );
    for (const doc of [full, abbreviated]) {
      const versions = doc.versions as Record<string, any>;
      expect(Object.keys(versions)).toEqual([
        "0.9.0",
        "1.0.0",
        "1.1.0",
        "1.2.0-beta.1",
      ]);
      expect(versions["1.1.0"].deprecated).toBe("broken build");
      expect(versions["0.9.0"].deprecated).toBe("use 1.x");
      expect(versions["1.0.0"].deprecated).toBeUndefined();
      // The yanked tag target is dropped; latest falls back to the newest non-yanked release.
      expect(doc["dist-tags"]).toEqual({
        latest: "1.0.0",
        beta: "1.2.0-beta.1",
      });
    }
  });

  it("copies only the allowlisted metadata; name and version come from the row", () => {
    const v = (packuments(fixture(), { origin: PKG }).full.versions as any)[
      "1.0.0"
    ];
    expect(v.scripts).toBeUndefined();
    expect(v.name).toBe("@acme/sdk");
    expect(v.version).toBe("1.0.0");
    expect(v._id).toBe("@acme/sdk@1.0.0");
  });

  it("a version without a tarball is not listed", () => {
    const f = fixture();
    const pkg = fixture({
      versions: [
        ...f.versions,
        { ...f.versions[1]!, version: "2.0.0", files: [] },
      ],
    });
    expect(
      Object.keys(packuments(pkg, { origin: PKG }).full.versions as object),
    ).not.toContain("2.0.0");
  });
});

describe("dist-tags and negotiation", () => {
  it("maps stable to latest and every other channel to its own name", () => {
    expect(channelTag("stable")).toBe("latest");
    expect(channelTag("beta")).toBe("beta");
    expect(channelTag("pr-5")).toBe("pr-5");
  });

  it("latest falls back to the newest non-yanked release, then the newest non-yanked prerelease", () => {
    const f = fixture();
    expect(distTags(fixture({ tags: {} }), f.versions)).toEqual({
      latest: "1.0.0",
    });
    const onlyPre = [f.versions[3]!];
    expect(distTags(fixture({ tags: {} }), onlyPre)).toEqual({
      latest: "1.2.0-beta.1",
    });
    expect(distTags(fixture({ tags: {} }), [f.versions[2]!])).toEqual({});
    // A tag naming a version that is not listed is dropped.
    expect(
      distTags(
        fixture({ tags: { latest: "1.0.0", next: "9.9.9" } }),
        f.versions,
      ),
    ).toEqual({ latest: "1.0.0" });
  });

  it("answers the abbreviated document only when Accept asks for it first", () => {
    // npm, pnpm, Yarn and Bun on install.
    expect(
      wantsAbbreviated(
        "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*",
      ),
    ).toBe(true);
    expect(wantsAbbreviated("application/vnd.npm.install-v1+json")).toBe(true);
    expect(wantsAbbreviated("application/vnd.npm.install-v1+json, */*")).toBe(
      true,
    );
    // npm view, browsers, curl.
    expect(wantsAbbreviated("application/json")).toBe(false);
    expect(wantsAbbreviated("*/*")).toBe(false);
    expect(wantsAbbreviated(null)).toBe(false);
    expect(
      wantsAbbreviated("application/json, application/vnd.npm.install-v1+json"),
    ).toBe(false);
    expect(
      wantsAbbreviated(
        "application/vnd.npm.install-v1+json;q=0.5, application/json",
      ),
    ).toBe(false);
    expect(wantsAbbreviated("application/vnd.npm.install-v1+json;q=0")).toBe(
      false,
    );
  });

  it("builds conventional tarball URLs (Yarn Berry rebuilds them)", () => {
    expect(tarballUrl(PKG, "acme", "@acme/sdk", "1.0.0")).toBe(
      `${PKG}/npm/acme/@acme/sdk/-/sdk-1.0.0.tgz`,
    );
  });
});

// ── The routes, end to end ───────────────────────────────────────────────────────────────────

const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });
const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};

const RELEASE_DOC = {
  release: {
    provider: { type: "github", owner: "acme", repo: "djdl" },
    binaryName: "djdl",
    deliverables: {
      app: {
        kind: "app",
        versioning: { scheme: "semver" },
        artifacts: [
          {
            id: "web",
            platform: "web",
            arch: "wasm32",
            format: "zip",
            match: "djdl-*-web.zip",
          },
        ],
      },
      "npm.sdk": {
        kind: "package",
        ecosystem: "npm",
        name: "@acme/sdk",
        artifacts: { tarball: { match: "sdk-*.tgz" } },
      },
    },
  },
};

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;

async function admin(method: string, path: string, body?: unknown) {
  const { token: t, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: ["platform-admins"] },
    NOW,
  );
  const full = `/api${path}`;
  return handleAdmin(
    new Request(`${CONSOLE}/manage${full}`, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${t}`,
        [CSRF_HEADER]: session.csrf,
        "content-type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    db,
    full,
    { now: NOW },
  );
}

function post(path: string, body: unknown) {
  return call(env, db, noFetch, `${CONSOLE}/${SLUG}/release/publish/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

const tgz = (v: string) =>
  new TextEncoder().encode(`npm pack output of @acme/sdk ${v}`);

/** Publish one version through uploads → staging → submit. */
async function publish(version: string, channel: string): Promise<void> {
  const bytes = tgz(version);
  const s = sha(bytes);
  const up = await post("uploads", {
    objects: [{ sha256: s, size: bytes.length }],
  });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { ticket: string; prefix: string };
  r2.seed(`${u.prefix}${s}`, bytes, { withSha256: true });
  const res = await post("submit", {
    ticket: u.ticket,
    descriptor: {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "npm.sdk",
      kind: "package",
      version,
      channel,
      package: {
        ecosystem: "npm",
        name: "@acme/sdk",
        files: [
          {
            name: `sdk-${version}.tgz`,
            role: "payload",
            type: "npm-tarball",
            sha256: s,
            size: bytes.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${s}` }],
          },
        ],
        metadata: {
          name: "@acme/sdk",
          version,
          description: "The Acme SDK",
          dependencies: {},
        },
      },
    },
  });
  expect(res.status, await res.clone().text()).toBe(200);
}

const releasePath = (v: string, action: string) =>
  `/products/${SLUG}/release/releases/${encodeURIComponent(`npm.sdk@${v}`)}/${action}`;

function get(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return dispatchRegistryHost(
    new Request(`${PKG}${path}`, { method, headers }),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
  );
}

const INSTALL_ACCEPT =
  "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

async function packument(
  path = `/npm/${SLUG}/@acme%2fsdk`,
  accept = "application/json",
): Promise<Record<string, any>> {
  const res = await get(path, { accept });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as Record<string, any>;
}

function expectHardened(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("content-security-policy")).toMatch(/^sandbox;/);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("set-cookie")).toBeNull();
}

describe("the npm routes (registry host)", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
    forgetRegistrySettings();
    db = makeTestDb();
    env = envFor({ kv: new KvMock() });
    env.KEY_HASH_PEPPER = "pepper";
    env.PKG_ORIGIN = PKG;
    r2 = new R2Mock();
    env.BLOBS = asR2(r2);
    Object.assign(env, R2_ENV);
    await seedReleaseProduct(db);
    const res = parseManifest({
      product: JSON.stringify({ slug: SLUG, name: "djdl" }),
      schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
      release: JSON.stringify(RELEASE_DOC),
    });
    if (!res.ok) throw new Error(res.errors.join("\n"));
    const rel = res.manifest.release!;
    await db.batch(
      manifestDeliverableStatements(
        SLUG,
        rel.app,
        NOW,
        rel.packDeliverables,
        rel.packageDeliverables,
      ),
    );
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
         max_package_bytes, updated_at) VALUES (?, 'npm', 1, ?, 52428800, ?)`,
      SLUG,
      JSON.stringify({ scope: "@acme" }),
      NOW,
    );
    await db.run(
      "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
      SLUG,
      NOW,
    );
    token = (
      await issueStaticCiToken(env, db, {
        product: SLUG,
        scopes: ["release:publish"],
        expiresAt: NOW + 3600,
        label: null,
        createdBy: "u1",
        now: NOW,
      })
    ).token;
    await publish("0.9.0", "stable");
    await publish("1.0.0", "stable");
    await publish("1.1.0", "stable");
    await publish("1.2.0-beta.1", "beta");
    expect(
      (
        await admin("POST", releasePath("0.9.0", "deprecate"), {
          message: "use 1.x",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin("POST", releasePath("1.1.0", "yank"), {
          reason: "broken build",
        })
      ).status,
    ).toBe(200);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves the full packument under both %2f spellings and the unescaped name, identically", async () => {
    const a = await packument(`/npm/${SLUG}/@acme%2fsdk`);
    const b = await packument(`/npm/${SLUG}/@acme%2Fsdk`);
    const c = await packument(`/npm/${SLUG}/@acme/sdk`);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.name).toBe("@acme/sdk");
    expect(Object.keys(a.versions)).toEqual([
      "0.9.0",
      "1.0.0",
      "1.1.0",
      "1.2.0-beta.1",
    ]);
    expect(a.time.created).toBeDefined();
  });

  it("channels become dist-tags; the yanked version leaves them and is deprecated; the deprecated one carries its message", async () => {
    const doc = await packument();
    expect(doc["dist-tags"].latest).toBe("1.0.0");
    expect(doc["dist-tags"].beta).toBe("1.2.0-beta.1");
    expect(Object.values(doc["dist-tags"])).not.toContain("1.1.0");
    expect(doc.versions["1.1.0"].deprecated).toBe("broken build");
    expect(doc.versions["0.9.0"].deprecated).toBe("use 1.x");
    expect(doc.versions["1.0.0"].deprecated).toBeUndefined();
  });

  it("negotiates the abbreviated packument by Accept, with Vary and the index headers", async () => {
    const res = await get(`/npm/${SLUG}/@acme%2fsdk`, {
      accept: INSTALL_ACCEPT,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(NPM_ABBREVIATED_TYPE);
    expect(res.headers.get("vary")).toBe("Accept");
    expect(res.headers.get("cache-control")).toBe(INDEX_CACHE_CONTROL);
    const body = await res.text();
    expect(res.headers.get("etag")).toBe(`"${sha(body)}"`);
    expectHardened(res);
    const doc = JSON.parse(body);
    expect(Object.keys(doc).sort()).toEqual([
      "dist-tags",
      "modified",
      "name",
      "versions",
    ]);
    expect(doc.versions["1.0.0"].description).toBeUndefined();

    const full = await get(`/npm/${SLUG}/@acme%2fsdk`, {
      accept: "application/json",
    });
    expect(full.headers.get("content-type")).toBe("application/json");
    expect(((await full.json()) as any).versions["1.0.0"].description).toBe(
      "The Acme SDK",
    );
  });

  it("serves every tarball, the yanked one included, with bytes matching dist.integrity and dist.shasum", async () => {
    const doc = await packument();
    for (const v of ["0.9.0", "1.0.0", "1.1.0", "1.2.0-beta.1"]) {
      const dist = doc.versions[v].dist;
      expect(dist.tarball).toBe(`${PKG}/npm/${SLUG}/@acme/sdk/-/sdk-${v}.tgz`);
      const res = await get(new URL(dist.tarball).pathname);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
      expect(res.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
      expectHardened(res);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes).toEqual(tgz(v));
      expect(dist.integrity).toBe(sri512(bytes));
      expect(dist.shasum).toBe(sha(bytes, "sha1"));
      expect(res.headers.get("etag")).toBe(`"${sha(bytes)}"`);
    }
    // The escaped spelling of the tarball path answers too; HEAD has the length and no body.
    const head = await get(
      `/npm/${SLUG}/@acme%2fsdk/-/sdk-1.0.0.tgz`,
      {},
      "HEAD",
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(tgz("1.0.0").length),
    );
    expect(await head.text()).toBe("");
  });

  it("answers 304 to a matching If-None-Match", async () => {
    const first = await get(`/npm/${SLUG}/@acme%2fsdk`);
    const etag = first.headers.get("etag")!;
    const again = await get(`/npm/${SLUG}/@acme%2fsdk`, {
      "if-none-match": etag,
    });
    expect(again.status).toBe(304);
  });

  it("answers the one not-found for unscoped names, unknown names and versions, and another scope", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET namespace_json = ? WHERE product = ?",
      JSON.stringify({ scope: "@other" }),
      SLUG,
    );
    forgetRegistrySettings();
    for (const path of [
      `/npm/${SLUG}/@acme%2fsdk`,
      `/npm/${SLUG}/@acme/sdk/-/sdk-1.0.0.tgz`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ error: "not_found" });
    }
    await db.run(
      "UPDATE dist_registry_feeds SET namespace_json = ? WHERE product = ?",
      JSON.stringify({ scope: "@acme" }),
      SLUG,
    );
    forgetRegistrySettings();
    for (const path of [
      `/npm/${SLUG}/sdk`,
      `/npm/${SLUG}/@acme%2fnope`,
      `/npm/${SLUG}/@acme/sdk/-/sdk-7.7.7.tgz`,
      `/npm/${SLUG}/@acme/sdk/1.0.0`,
      `/npm/nobody/@acme%2fsdk`,
      `/npm/${SLUG}/@ACME%2fsdk`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expectHardened(res);
    }
  });

  it("a feed that is off answers the not-found; a non-public feed answers npm's Basic challenge", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE product = ?",
      SLUG,
    );
    forgetRegistrySettings();
    expect((await get(`/npm/${SLUG}/@acme%2fsdk`)).status).toBe(404);
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 1, access_mode = 'licensed' WHERE product = ?",
      SLUG,
    );
    forgetRegistrySettings();
    for (const path of [
      `/npm/${SLUG}/@acme%2fsdk`,
      `/npm/${SLUG}/@acme/sdk/-/sdk-1.0.0.tgz`,
    ]) {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(
        'Basic realm="pkg.example.test"',
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("stores the render in R2, serves it while it is current, and re-renders after a yank, an unyank and a channel pin", async () => {
    const key = `registry/npm/${SLUG}/@acme/sdk/full.json`;
    const misses = registryCounters.renderMiss;
    await packument();
    expect(registryCounters.renderMiss).toBe(misses + 1);
    const stored = await r2.head(key);
    expect(stored?.customMetadata?.[RENDER_STAMP_META]).toMatch(
      /^[0-9a-f]{32}$/,
    );
    // Current: served from R2, no miss.
    await packument();
    expect(registryCounters.renderMiss).toBe(misses + 1);

    expect((await admin("DELETE", releasePath("1.1.0", "yank"))).status).toBe(
      200,
    );
    let doc = await packument();
    expect(doc["dist-tags"].latest).toBe("1.1.0");
    expect(doc.versions["1.1.0"].deprecated).toBeUndefined();
    expect(registryCounters.renderMiss).toBe(misses + 2);

    expect(
      (await admin("POST", releasePath("1.0.0", "yank"), { reason: "cve" }))
        .status,
    ).toBe(200);
    doc = await packument();
    expect(doc.versions["1.0.0"].deprecated).toBe("cve");
    expect(doc["dist-tags"].latest).toBe("1.1.0");

    const move = await admin("PUT", `/products/${SLUG}/release/channels/beta`, {
      deliverable: "npm.sdk",
      pointer: "npm.sdk@1.1.0",
      pinned: true,
    });
    expect(move.status, await move.clone().text()).toBe(200);
    doc = await packument();
    expect(doc["dist-tags"].beta).toBe("1.1.0");
  });

  it("deprecation without a message, and a yank without a reason, get npm's non-empty messages", () => {
    const f = fixture();
    const pkg = fixture({
      versions: [
        { ...f.versions[0]!, stateMessage: null },
        { ...f.versions[2]!, stateMessage: "  " },
      ],
    });
    const v = packuments(pkg, { origin: PKG }).full.versions as any;
    expect(v["0.9.0"].deprecated).toBe(DEPRECATED_MESSAGE);
    expect(v["1.1.0"].deprecated).toBe(YANKED_MESSAGE);
  });
});
