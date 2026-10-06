/**
 * The Maven feed (F-07, plans/F-01.md §6.7, §6.8) through the real registry host: the rendered
 * `maven-metadata.xml` and its sidecars (golden files), the static layout of a version's files
 * with their derived checksums, the headers of §6.7 on every answer, yank / deprecate / channel
 * behaviour, render-on-stale, and the access ladder in front of all of it.
 *
 * The fixture is published through Release's real package ingest and yanked and deprecated
 * through Release's real policy functions: a stable line (0.9.0, 1.0.0, 1.1.0), a beta
 * (1.2.0-beta.1), one yanked version (1.1.0) and one deprecated (0.9.0).
 *
 * Regenerate the goldens with `UPDATE_FEED_GOLDENS=1` after an intended change, and review the
 * diff: they are what Gradle and Maven read.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { REGISTRY_ROUTES, SERVICES } from "../../src/mount.js";
import {
  REGISTRY_CSP,
  REGISTRY_HOST_TYPES,
  dispatchRegistryHost,
} from "../../src/core/registryHost.js";
import { blobKey, recordObject } from "../../src/core/blobs.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { setServices } from "../../src/repo.js";
import { stmtUpsertDeliverable } from "../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../src/services/release/packages/ingest.js";
import {
  setPackageDeprecation,
  yank,
  type PolicyActor,
} from "../../src/services/release/policy.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  registryCounters,
  registryObjectKey,
  type RegistryPackage,
} from "../../src/services/distribution/registry/materialise.js";
import {
  matchMavenFile,
  matchMavenMetadata,
} from "../../src/services/distribution/registry/maven/routes.js";
import {
  MAVEN_CHECKSUMS,
  mavenMetadataXml,
  mavenTimestamp,
  renderMaven,
} from "../../src/services/distribution/registry/maven/render.js";
import { MAVEN_RENDERER } from "../../src/services/distribution/registry/maven/index.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { R2Mock, asR2 } from "../r2Mock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "..", "fixtures", "registry", "maven");
const PKG = "https://pkg.example.test";
const OWNER = "acme";
const GROUP = "im.acme.sdk";
const ARTIFACT = "demo";
const NAME = `${GROUP}:${ARTIFACT}`;
const DELIVERABLE = "maven.demo";
const DIR = `/maven/${OWNER}/im/acme/sdk/demo`;

const ON: ServicesMap = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
};
const ACTOR: PolicyActor = {
  kind: "admin",
  session: {
    sub: "u1",
    name: "Ada",
    email: "ada@x.io",
    groups: ["platform-admins"],
    csrf: "c",
    exp: NOW + 3600,
  },
};

const hex = (algo: string, b: Uint8Array | string) =>
  createHash(algo).update(b).digest("hex");

/** The bytes of every file of a version: an empty jar (a zip whose comment names it), its POM
 *  and Gradle module metadata. Distinct per version, so every digest differs. */
function versionFiles(
  version: string,
  sources = false,
): Map<string, Uint8Array> {
  const enc = new TextEncoder();
  const zip = (comment: string) => {
    const c = enc.encode(comment);
    const eocd = new Uint8Array(22 + c.length);
    eocd.set([0x50, 0x4b, 0x05, 0x06]);
    eocd[20] = c.length & 0xff;
    eocd[21] = c.length >> 8;
    eocd.set(c, 22);
    return eocd;
  };
  const files = new Map<string, Uint8Array>();
  files.set(`${ARTIFACT}-${version}.jar`, zip(`${NAME}:${version}`));
  if (sources)
    files.set(
      `${ARTIFACT}-${version}-sources.jar`,
      zip(`${NAME}:${version}:sources`),
    );
  files.set(
    `${ARTIFACT}-${version}.pom`,
    enc.encode(
      `<?xml version="1.0" encoding="UTF-8"?>\n<project><modelVersion>4.0.0</modelVersion>` +
        `<groupId>${GROUP}</groupId><artifactId>${ARTIFACT}</artifactId>` +
        `<version>${version}</version><packaging>jar</packaging></project>\n`,
    ),
  );
  files.set(
    `${ARTIFACT}-${version}.module`,
    enc.encode(
      JSON.stringify({
        formatVersion: "1.1",
        component: { group: GROUP, module: ARTIFACT, version },
      }),
    ),
  );
  return files;
}

let db: Db;
let env: Env;
let r2: R2Mock;
/** Every file published, by name, for byte comparisons. */
const published = new Map<string, Uint8Array>();

async function publish(
  version: string,
  channel: string,
  at: number,
  sources = false,
): Promise<void> {
  const files = versionFiles(version, sources);
  const descriptorFiles = [];
  for (const [name, bytes] of files) {
    const sha256 = hex("sha256", bytes);
    await asR2(r2).put(blobKey(sha256), bytes, { sha256 });
    await recordObject(
      db,
      {
        storageKey: blobKey(sha256),
        sha256,
        size: bytes.length,
        kind: "blob",
        gated: false,
      },
      at,
    );
    published.set(name, bytes);
    const ext = name.slice(
      name.indexOf(".", `${ARTIFACT}-${version}`.length) + 1,
    );
    descriptorFiles.push({
      name,
      role: "payload",
      type: "maven-file",
      sha256,
      size: bytes.length,
      extension: ext,
      ...(name.includes("-sources.") ? { classifier: "sources" } : {}),
      locations: [{ provider: "r2", key: blobKey(sha256) }],
    });
  }
  const res = await ingestPackageDescriptor(
    db,
    env,
    OWNER,
    {
      descriptorVersion: 1,
      product: OWNER,
      deliverable: DELIVERABLE,
      kind: "package",
      version,
      channel,
      package: {
        ecosystem: "maven",
        name: NAME,
        files: descriptorFiles,
        metadata: {
          name: NAME,
          version,
          groupId: GROUP,
          artifactId: ARTIFACT,
          packaging: "jar",
        },
      },
    },
    {
      now: at,
      promoted: descriptorFiles.map((f) => f.locations[0]!.key),
      feed: {
        ecosystem: "maven",
        enabled: true,
        ownerEnabled: true,
        policyEnabled: true,
        namespace: { groupPrefixes: ["im.acme"] },
        maxPackageBytes: 52428800,
        ext: {},
      },
      source: { kind: "static" },
      // The real ingest streams these from R2; here they come from the bytes we hold.
      digests: async (rows) =>
        new Map(
          rows.map((r) => {
            const b = files.get(r.name)!;
            return [
              r.name,
              {
                sha1: hex("sha1", b),
                sha512: hex("sha512", b),
                md5: hex("md5", b),
              },
            ];
          }),
        ),
    },
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

async function setFeed(over: { enabled?: number; access_mode?: string } = {}) {
  await db.run(
    `INSERT INTO dist_registry_owners (product, enabled, version, updated_at) VALUES (?, 1, 1, ?)
       ON CONFLICT(product) DO UPDATE SET enabled = 1`,
    OWNER,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_registry_feeds
       (product, ecosystem, enabled, access_mode, namespace_json, max_package_bytes, updated_at)
     VALUES (?, 'maven', ?, ?, ?, 52428800, ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET enabled = excluded.enabled,
       access_mode = excluded.access_mode`,
    OWNER,
    over.enabled ?? 1,
    over.access_mode ?? "public",
    JSON.stringify({ groupPrefixes: ["im.acme"] }),
    NOW,
  );
  forgetRegistrySettings();
}

function get(path: string, init: RequestInit = {}): Promise<Response> {
  return dispatchRegistryHost(
    new Request(PKG + path, init),
    env,
    db,
    REGISTRY_ROUTES,
    SERVICES,
  );
}

/** The host's headers (plans/F-01.md §6.1) and a type on the allowlist that is never XML. */
function expectHardened(res: Response, label: string): void {
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("content-security-policy"), label).toBe(REGISTRY_CSP);
  expect(res.headers.get("referrer-policy"), label).toBe("no-referrer");
  expect(res.headers.get("cross-origin-resource-policy"), label).toBe(
    "same-origin",
  );
  expect(res.headers.get("set-cookie"), label).toBeNull();
  const type = res.headers.get("content-type");
  if (type !== null) {
    expect(type, label).not.toMatch(/xml|html|text\//i);
    expect(REGISTRY_HOST_TYPES.has(type.split(";")[0]!.trim()), label).toBe(
      true,
    );
  }
}

function golden(name: string, actual: string): void {
  const file = join(GOLDEN, name);
  if (process.env.UPDATE_FEED_GOLDENS === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
  }
  expect(actual, name).toBe(readFileSync(file, "utf8"));
}

beforeEach(async () => {
  db = makeTestDb();
  r2 = new R2Mock();
  env = makeEnv(new KvMock(), []);
  env.PKG_ORIGIN = PKG;
  env.BLOBS = asR2(r2);
  published.clear();
  await seedProduct(db, OWNER);
  await setServices(
    db,
    OWNER,
    serializeServices({ services: ON }),
    "admin",
    NOW,
  );
  const decl = {
    kind: "package" as const,
    id: DELIVERABLE,
    ecosystem: "maven" as const,
    name: NAME,
    artifacts: { files: { match: "build/repo/**" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product: OWNER,
      deliverableId: DELIVERABLE,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "maven",
      packageName: NAME,
    },
    NOW,
  );
  await db.run(s.sql, ...s.params);
  // The deliverable's delivery mode (resync writes one per deliverable; no row is `entitled`).
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at)
     VALUES (?, ?, 'public', 'manifest', ?)`,
    OWNER,
    DELIVERABLE,
    NOW,
  );
  await setFeed();
  await publish("0.9.0", "stable", NOW + 60);
  await publish("1.0.0", "stable", NOW + 120, true);
  await publish("1.1.0", "stable", NOW + 180);
  await publish("1.2.0-beta.1", "beta", NOW + 240);
  const y = await yank(
    env,
    db,
    OWNER,
    `${DELIVERABLE}@1.1.0`,
    "broken build",
    ACTOR,
    NOW + 300,
  );
  expect(y.ok).toBe(true);
  const d = await setPackageDeprecation(
    env,
    db,
    OWNER,
    `${DELIVERABLE}@0.9.0`,
    "use 1.0.0",
    ACTOR,
    NOW + 360,
  );
  expect(d.ok).toBe(true);
});

describe("maven-metadata.xml (rendered, golden)", () => {
  it("lists every version but the yanked one, with release = the stable head and latest = the newest", async () => {
    const res = await get(`${DIR}/maven-metadata.xml`);
    expect(res.status).toBe(200);
    expectHardened(res, "metadata");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="maven-metadata.xml"',
    );
    const body = await res.text();
    golden("maven-metadata.xml", body);
    expect(body).toContain("<release>1.0.0</release>");
    expect(body).toContain("<latest>1.2.0-beta.1</latest>");
    expect(body).toContain("<version>0.9.0</version>"); // deprecated: still listed
    expect(body).not.toContain("1.1.0"); // yanked: gone from the index
    // §6.7: an index document, with a strong ETag of the body's SHA-256.
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=60",
    );
    expect(res.headers.get("etag")).toBe(`"${hex("sha256", body)}"`);
  });

  it("serves the four sidecars of the metadata, each the digest of the served body", async () => {
    const body = await (await get(`${DIR}/maven-metadata.xml`)).text();
    for (const algo of MAVEN_CHECKSUMS) {
      const res = await get(`${DIR}/maven-metadata.xml.${algo}`);
      expect(res.status, algo).toBe(200);
      expectHardened(res, algo);
      const side = await res.text();
      expect(side, algo).toBe(hex(algo, body));
      golden(`maven-metadata.xml.${algo}`, side);
      expect(res.headers.get("cache-control"), algo).toBe(
        "public, max-age=60, stale-while-revalidate=60",
      );
    }
  });

  it("renders into R2 under registry/maven/<owner>/ and re-renders when the package's state changes", async () => {
    const key = registryObjectKey(
      "maven",
      OWNER,
      "im/acme/sdk/demo/maven-metadata.xml",
    );
    const before = registryCounters.renderMiss;
    await get(`${DIR}/maven-metadata.xml`);
    expect(registryCounters.renderMiss).toBe(before + 1);
    expect(r2.keys()).toContain(key);
    // A second read is served from the stored render.
    await get(`${DIR}/maven-metadata.xml`);
    expect(registryCounters.renderMiss).toBe(before + 1);
    // A new stable publish moves `release` and `latest` on the next read, drain or no drain.
    await publish("1.3.0", "stable", NOW + 420);
    const body = await (await get(`${DIR}/maven-metadata.xml`)).text();
    expect(body).toContain("<release>1.3.0</release>");
    expect(body).toContain("<latest>1.3.0</latest>");
    expect(body).toContain(
      `<lastUpdated>${mavenTimestamp(NOW + 420)}</lastUpdated>`,
    );
  });

  it("an unyank returns the version to the index", async () => {
    const { unyank } = await import("../../src/services/release/policy.js");
    expect(
      (await unyank(env, db, OWNER, `${DELIVERABLE}@1.1.0`, ACTOR, NOW + 400))
        .ok,
    ).toBe(true);
    const body = await (await get(`${DIR}/maven-metadata.xml`)).text();
    expect(body).toContain("<version>1.1.0</version>");
    expect(body).toContain("<release>1.1.0</release>");
  });

  it("HEAD answers the headers without a body", async () => {
    const res = await get(`${DIR}/maven-metadata.xml`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
  });
});

describe("a version's files (the static layout)", () => {
  it("serves the POM, the .module, the jar and a classified jar as opaque, immutable attachments", async () => {
    for (const name of [
      "demo-1.0.0.pom",
      "demo-1.0.0.module",
      "demo-1.0.0.jar",
      "demo-1.0.0-sources.jar",
    ]) {
      const res = await get(`${DIR}/1.0.0/${name}`);
      expect(res.status, name).toBe(200);
      expectHardened(res, name);
      expect(res.headers.get("content-type"), name).toBe(
        "application/octet-stream",
      );
      expect(res.headers.get("content-disposition"), name).toBe(
        `attachment; filename="${name}"`,
      );
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes, name).toEqual(published.get(name));
      expect(res.headers.get("etag"), name).toBe(`"${hex("sha256", bytes)}"`);
      expect(res.headers.get("cache-control"), name).toMatch(
        /^public, max-age=31536000, immutable\b/,
      );
    }
  });

  it("serves .md5, .sha1, .sha256 and .sha512 for every file, from the digests ingest recorded", async () => {
    for (const name of [
      "demo-1.0.0.pom",
      "demo-1.0.0.module",
      "demo-1.0.0.jar",
    ]) {
      for (const algo of MAVEN_CHECKSUMS) {
        const res = await get(`${DIR}/1.0.0/${name}.${algo}`);
        expect(res.status, `${name}.${algo}`).toBe(200);
        expectHardened(res, `${name}.${algo}`);
        expect(await res.text(), `${name}.${algo}`).toBe(
          hex(algo, published.get(name)!),
        );
        expect(res.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      }
    }
  });

  it("keeps a yanked version's files downloadable by exact coordinates (pinned builds keep working)", async () => {
    const res = await get(`${DIR}/1.1.0/demo-1.1.0.pom`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      published.get("demo-1.1.0.pom"),
    );
  });

  it("supports HEAD and Range on files", async () => {
    const head = await get(`${DIR}/1.0.0/demo-1.0.0.jar`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const part = await get(`${DIR}/1.0.0/demo-1.0.0.jar`, {
      headers: { range: "bytes=0-3" },
    });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(
      published.get("demo-1.0.0.jar")!.slice(0, 4),
    );
  });

  it("answers the not-found for anything outside a publication", async () => {
    for (const path of [
      `${DIR}/9.9.9/demo-9.9.9.jar`, // no such version
      `${DIR}/1.0.0/demo-1.0.0-javadoc.jar`, // no such file
      `${DIR}/1.0.0/demo-0.9.0.jar`, // another version's file under this one
      `${DIR}/1.0.0/demo-1.0.0.jar.asc`, // signatures are not served
      `${DIR}/1.0.0/maven-metadata.xml`, // no version-level metadata (no snapshots)
      `${DIR}/1.0.0/`,
      `/maven/${OWNER}/im/acme/sdk/other/maven-metadata.xml`, // unknown artifact
      `/maven/${OWNER}/IM/acme/sdk/demo/maven-metadata.xml`, // paths are case-sensitive
      `/maven/${OWNER}/im/acme/sdk/demo/maven-metadata.xml.sha3`,
      `/maven/nobody/im/acme/sdk/demo/maven-metadata.xml`, // unknown owner
      `/maven/${OWNER}/demo/maven-metadata.xml`, // no group
      `/maven/${OWNER}/im/acme/%2e%2e/demo/maven-metadata.xml`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "not_found" });
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expectHardened(res, path);
    }
  });

  it("a sidecar the file carries no digest for is the not-found", async () => {
    await db.run(
      `UPDATE release_packages SET files_json = json_remove(files_json, '$[0].md5')
        WHERE product = ? AND version = '1.0.0'`,
      OWNER,
    );
    const first = JSON.parse(
      (await db.first<{ f: string }>(
        "SELECT files_json AS f FROM release_packages WHERE product = ? AND version = '1.0.0'",
        OWNER,
      ))!.f,
    )[0].name as string;
    expect((await get(`${DIR}/1.0.0/${first}.md5`)).status).toBe(404);
    expect((await get(`${DIR}/1.0.0/${first}.sha1`)).status).toBe(200);
  });
});

describe("defensive reads", () => {
  it("a file row whose digest cannot name a blob is the not-found, not a 500", async () => {
    await db.run(
      `UPDATE release_packages SET files_json = json_set(files_json, '$[0].sha256', 'zz')
        WHERE product = ? AND version = '1.0.0'`,
      OWNER,
    );
    const first = JSON.parse(
      (await db.first<{ f: string }>(
        "SELECT files_json AS f FROM release_packages WHERE product = ? AND version = '1.0.0'",
        OWNER,
      ))!.f,
    )[0].name as string;
    const res = await get(`${DIR}/1.0.0/${first}`);
    expect(res.status).toBe(404);
    expectHardened(res, first);
  });
});

describe("the access ladder in front of the feed", () => {
  it("a disabled feed, packageFeeds off or Distribution off reads as absent", async () => {
    await setFeed({ enabled: 0 });
    expect((await get(`${DIR}/maven-metadata.xml`)).status).toBe(404);
    expect((await get(`${DIR}/1.0.0/demo-1.0.0.jar`)).status).toBe(404);
    await setFeed();
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 0 WHERE product = ?",
      OWNER,
    );
    forgetRegistrySettings();
    expect((await get(`${DIR}/maven-metadata.xml`)).status).toBe(404);
    await db.run(
      "UPDATE dist_registry_owners SET enabled = 1 WHERE product = ?",
      OWNER,
    );
    await setServices(
      db,
      OWNER,
      serializeServices({
        services: { ...ON, distribution: { enabled: false } },
      }),
      "admin",
      NOW,
    );
    forgetRegistrySettings();
    expect((await get(`${DIR}/maven-metadata.xml`)).status).toBe(404);
  });

  it("a non-public feed answers HTTP Basic's challenge, for packages it holds and does not alike", async () => {
    await setFeed({ access_mode: "authenticated" });
    for (const path of [
      `${DIR}/maven-metadata.xml`,
      `${DIR}/1.0.0/demo-1.0.0.jar`,
      `/maven/${OWNER}/im/acme/sdk/other/maven-metadata.xml`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBe(
        'Basic realm="pkg.example.test"',
      );
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expectHardened(res, path);
    }
  });

  it("GET and HEAD only, beside F-22's deploy PUT (which needs a publish credential)", async () => {
    const res = await get(`${DIR}/1.0.0/demo-1.0.0.jar`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
    const put = await get(`${DIR}/1.0.0/demo-1.0.0.jar`, {
      method: "PUT",
      body: "x",
    });
    expect(put.status).toBe(401);
    expect(put.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
  });
});

describe("the matchers", () => {
  it("parse the group path, artifact, version and file", () => {
    expect(
      matchMavenMetadata(
        "/maven/acme/im/acme/sdk/demo/maven-metadata.xml.sha1",
      ),
    ).toEqual({
      owner: "acme",
      params: { groupId: "im.acme.sdk", artifactId: "demo", checksum: "sha1" },
    });
    expect(
      matchMavenFile("/maven/acme/im/acme/sdk/demo/1.0.0/demo-1.0.0.pom"),
    ).toEqual({
      owner: "acme",
      params: {
        groupId: "im.acme.sdk",
        artifactId: "demo",
        version: "1.0.0",
        file: "demo-1.0.0.pom",
      },
    });
  });

  it("refuse escapes, dot segments, empty segments and too-short paths", () => {
    for (const p of [
      "/maven/acme/demo/maven-metadata.xml",
      "/maven/acme/im/../demo/maven-metadata.xml",
      "/maven/acme/im/./demo/maven-metadata.xml",
      "/maven/acme/im//demo/maven-metadata.xml",
      "/maven/acme/im/%2e/demo/maven-metadata.xml",
      "/maven/acme/im/acme/demo/maven-metadata.xml.asc",
      "/npm/acme/im/acme/demo/maven-metadata.xml",
    ])
      expect(matchMavenMetadata(p), p).toBeNull();
    for (const p of [
      "/maven/acme/im/demo/1.0.0",
      "/maven/acme/demo/1.0.0/demo-1.0.0.jar",
      "/maven/acme/im/demo/1.0.0/maven-metadata.xml",
      "/maven/acme/im/demo/1.0.0/..",
      "/maven/acme/im/demo/1.0.0/",
    ])
      expect(matchMavenFile(p), p).toBeNull();
  });
});

describe("the renderer", () => {
  const base: RegistryPackage = {
    product: OWNER,
    ecosystem: "maven",
    deliverableId: DELIVERABLE,
    name: NAME,
    nameNorm: NAME.toLowerCase(),
    versions: [],
    tags: {},
  };
  const v = (
    version: string,
    state: "live" | "yanked" | "deprecated",
    at: number,
  ) => ({
    version,
    state,
    stateMessage: null,
    files: [],
    metadata: {},
    publishedAt: at,
  });

  it("is registered for maven, with its two routes", () => {
    expect(MAVEN_RENDERER.ecosystem).toBe("maven");
    expect(MAVEN_RENDERER.routes.map((r) => r.name)).toEqual([
      "mavenMetadata",
      "mavenFile",
    ]);
    for (const r of MAVEN_RENDERER.routes) expect(REGISTRY_ROUTES).toContain(r);
  });

  it("renders the metadata and its four sidecars, every one application/octet-stream", () => {
    const objs = renderMaven({
      ...base,
      versions: [v("1.0.0", "live", NOW)],
      tags: { latest: "1.0.0" },
    });
    expect(objs.map((o) => o.key)).toEqual([
      "im/acme/sdk/demo/maven-metadata.xml",
      "im/acme/sdk/demo/maven-metadata.xml.sha512",
      "im/acme/sdk/demo/maven-metadata.xml.sha256",
      "im/acme/sdk/demo/maven-metadata.xml.sha1",
      "im/acme/sdk/demo/maven-metadata.xml.md5",
    ]);
    for (const o of objs)
      expect(o.contentType).toBe("application/octet-stream");
  });

  it("with every version yanked: an empty version list, no latest, no release", () => {
    const xml = mavenMetadataXml({
      ...base,
      versions: [v("1.0.0", "yanked", NOW)],
      tags: { latest: "1.0.0" },
    });
    expect(xml).toContain("<versions/>");
    expect(xml).not.toMatch(/<latest>|<release>|<lastUpdated>/);
  });

  it("omits release when the stable channel serves nothing; a beta is latest only", () => {
    const xml = mavenMetadataXml({
      ...base,
      versions: [v("2.0.0-beta.1", "live", NOW)],
      tags: { beta: "2.0.0-beta.1" },
    });
    expect(xml).toContain("<latest>2.0.0-beta.1</latest>");
    expect(xml).not.toContain("<release>");
  });

  it("formats lastUpdated as Maven's UTC yyyyMMddHHmmss", () => {
    expect(mavenTimestamp(Date.UTC(2026, 9, 4, 7, 5, 9) / 1000)).toBe(
      "20261004070509",
    );
  });
});
