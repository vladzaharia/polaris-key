/**
 * F-08 — the OCI feed on the registry host (plans/F-01.md §6.2, §6.7 and §6.8): the renderer's
 * golden files, the tag rules (version tags never move, channel tags do, a yanked version has
 * no tag, a deprecated one is served), and the pull routes through the real dispatcher with
 * the real Release catalog, over a repository published through the real package ingest.
 *
 * Golden files live in `test/fixtures/registry/oci/` (`UPDATE_REGISTRY_GOLDENS=1` rewrites them).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  REGISTRY_CSP,
  dispatchRegistryHost,
} from "../src/core/registryHost.js";
import { serializeServices, type ServicesMap } from "../src/core/services.js";
import { setServices } from "../src/repo.js";
import { REGISTRY_ROUTES, SERVICES } from "../src/mount.js";
import {
  IMMUTABLE_CACHE_CONTROL,
  INDEX_CACHE_CONTROL,
} from "../src/services/distribution/registry/cache.js";
import {
  RENDER_STAMP_META,
  materialise,
  registryObjectKey,
  renderStamp,
} from "../src/services/distribution/registry/materialise.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";
import { RENDERERS } from "../src/services/distribution/registry/index.js";
import {
  ociRefs,
  renderOci,
} from "../src/services/distribution/registry/oci/render.js";
import {
  MAX_TAGS_PAGE,
  acceptsManifest,
} from "../src/services/distribution/registry/oci/routes.js";
import { unyank } from "../src/services/release/policy.js";
import type { AdminSession } from "../src/admin/session.js";
import { packageCatalog } from "../src/services/release/packages/catalog.js";
import { ociPackage } from "../src/services/distribution/registry/oci/source.js";
import { loadProductPublic } from "../src/core/products.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2 } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import {
  DOCKER_MANIFEST,
  OCI_ID,
  OCI_INDEX,
  OCI_MANIFEST,
  OCI_REPO,
  ociFixturePackage,
  publishOciFixture,
  type OciFixtureVersion,
} from "./ociFixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "fixtures", "registry", "oci");
const PKG = "https://pkg.example.test";
const OWNER = "acme";
const NAME = `${OWNER}/${OCI_REPO}`;
const ON: ServicesMap = {
  license: { enabled: false },
  config: { enabled: false },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: false },
  identity: { enabled: false },
  sync: { enabled: false },
};

function golden(file: string, body: string): void {
  const path = join(GOLDEN, file);
  if (process.env.UPDATE_REGISTRY_GOLDENS === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, body);
  }
  expect(body, file).toBe(readFileSync(path, "utf8"));
}

const sha256 = (b: string | Uint8Array) =>
  createHash("sha256").update(b).digest("hex");

// ── The renderer ─────────────────────────────────────────────────────────────────────────────

describe("the OCI renderer (golden files)", () => {
  it("renders the tag list and the tag pointers of the fixture repository", () => {
    const objects = renderOci(ociFixturePackage(OWNER));
    expect(objects.map((o) => [o.key, o.contentType])).toEqual([
      ["tools/app/_tags.json", "application/json"],
      ["tools/app/_refs.json", "application/json"],
    ]);
    golden("tags.json", objects[0]!.body as string);
    golden("refs.json", objects[1]!.body as string);
  });

  it("is registered for `oci` and owns the three pull routes", () => {
    const r = RENDERERS.get("oci")!;
    expect(r.ecosystem).toBe("oci");
    expect(r.routes.map((x) => x.name)).toEqual([
      "oci.manifests",
      "oci.blobs",
      "oci.tags",
    ]);
    for (const route of r.routes) {
      expect(route.service).toBe("distribution");
      expect(route.ecosystem).toBe("oci");
    }
  });
});

describe("the OCI tag rules (§6.3, §6.7)", () => {
  const base = ociFixturePackage(OWNER);
  const v = (version: string) =>
    base.versions.find((x) => x.version === version)!;

  it("tags every version but the yanked one, plus latest, beta and dev, in lexical order", () => {
    const refs = ociRefs(base);
    expect(Object.keys(refs)).toEqual([
      "0.8.0",
      "1.0.0",
      "1.1.0-beta.1",
      "beta",
      "dev",
      "latest",
    ]);
    expect(refs.latest).toEqual(refs["1.0.0"]);
    expect(refs.beta).toEqual(refs["1.1.0-beta.1"]);
    expect(refs.dev).toEqual(refs["1.1.0-beta.1"]);
    expect(refs["1.0.0"]!.mediaType).toBe(OCI_INDEX);
    // The deprecated version is served like a live one (OCI has no deprecation field).
    expect(refs["0.8.0"]!.mediaType).toBe(DOCKER_MANIFEST);
  });

  it("a version tag never moves: a channel spelled like a version is dropped", () => {
    const refs = ociRefs({
      ...base,
      tags: { ...base.tags, "1.0.0": "0.8.0" },
    });
    expect(refs["1.0.0"]!.digest).toBe(v("1.0.0").metadata.root);
  });

  it("a channel tag pointing at a yanked or unknown version is dropped, an invalid tag too", () => {
    const refs = ociRefs({
      ...base,
      tags: { old: "0.9.0", ghost: "7.0.0", "bad tag": "1.0.0", ".x": "1.0.0" },
    });
    expect(Object.keys(refs)).toEqual(["0.8.0", "1.0.0", "1.1.0-beta.1"]);
  });

  it("leaves out a version whose root is not its own manifest, or not a servable type", () => {
    const strayRoot = {
      ...v("1.0.0"),
      metadata: { ...v("1.0.0").metadata, root: `sha256:${"f".repeat(64)}` },
    };
    const blobRoot = {
      ...v("1.1.0-beta.1"),
      files: v("1.1.0-beta.1").files.map((f) =>
        `sha256:${f.sha256}` === v("1.1.0-beta.1").metadata.root
          ? { ...f, type: "oci-blob" }
          : f,
      ),
    };
    const oddType = {
      ...v("0.8.0"),
      files: v("0.8.0").files.map((f) => ({
        ...f,
        mediaType: "application/vnd.cncf.helm.config.v1+json",
      })),
    };
    expect(
      ociRefs({ ...base, versions: [strayRoot, blobRoot, oddType], tags: {} }),
    ).toEqual({});
  });
});

describe("Accept negotiation for manifests", () => {
  const req = (accept?: string) =>
    new Request(PKG, accept === undefined ? {} : { headers: { accept } });
  it("serves the stored type unless Accept lists only other manifest types", () => {
    expect(acceptsManifest(req(), OCI_INDEX)).toBe(true);
    expect(acceptsManifest(req("*/*"), OCI_INDEX)).toBe(true);
    expect(
      acceptsManifest(req(`${OCI_MANIFEST}, ${OCI_INDEX}`), OCI_INDEX),
    ).toBe(true);
    expect(acceptsManifest(req("application/json"), OCI_INDEX)).toBe(true);
    expect(
      acceptsManifest(
        req(`${DOCKER_MANIFEST};q=0.9, ${OCI_MANIFEST}`),
        OCI_INDEX,
      ),
    ).toBe(false);
  });
});

// ── The routes, end to end ───────────────────────────────────────────────────────────────────

describe("OCI pull through the registry host (F-08)", () => {
  let db: Db;
  let env: Env;
  let bucket: R2Mock;
  let fixture: OciFixtureVersion[];
  const ver = (v: string) => fixture.find((x) => x.version === v)!;

  async function get(path: string, init: RequestInit = {}): Promise<Response> {
    return dispatchRegistryHost(
      new Request(`${PKG}${path}`, init),
      env,
      db,
      REGISTRY_ROUTES,
      SERVICES,
    );
  }

  function hardened(res: Response, at: string): void {
    expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
    expect(res.headers.get("content-security-policy"), at).toBe(REGISTRY_CSP);
    expect(res.headers.get("cross-origin-resource-policy"), at).toBe(
      "same-origin",
    );
    expect(res.headers.get("referrer-policy"), at).toBe("no-referrer");
    expect(res.headers.get("docker-distribution-api-version"), at).toBe(
      "registry/2.0",
    );
  }

  async function ociCode(res: Response): Promise<string> {
    const body = (await res.json()) as { errors: { code: string }[] };
    return body.errors[0]!.code;
  }

  beforeEach(async () => {
    forgetRegistrySettings();
    db = makeTestDb();
    await seedProduct(db, OWNER);
    await setServices(
      db,
      OWNER,
      serializeServices({ services: ON }),
      "manifest",
      NOW,
    );
    await db.run(
      "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
      OWNER,
      NOW,
    );
    await db.run(
      `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json, max_package_bytes, updated_at)
       VALUES (?, 'oci', 1, '{}', 5368709120, ?)`,
      OWNER,
      NOW,
    );
    bucket = new R2Mock();
    env = makeEnv(new KvMock(), []);
    env.PKG_ORIGIN = PKG;
    env.BLOBS = asR2(bucket);
    fixture = await publishOciFixture(db, env, bucket, OWNER, NOW);
  });

  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches;
  });

  it("tags/list answers the rendered list, an index document, and writes it back to R2", async () => {
    const res = await get(`/v2/${NAME}/tags/list`);
    hardened(res, "tags");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe(INDEX_CACHE_CONTROL);
    const body = await res.text();
    golden("tags.json", body);
    expect(res.headers.get("etag")).toBe(`"${sha256(body)}"`);
    expect(JSON.parse(body)).toEqual({
      name: NAME,
      tags: ["0.8.0", "1.0.0", "1.1.0-beta.1", "beta", "dev", "latest"],
    });
    const stored = await bucket.get(
      registryObjectKey("oci", OWNER, `${OCI_REPO}/_tags.json`),
    );
    expect(stored).not.toBeNull();
    expect(
      (stored as R2ObjectBody).customMetadata?.[RENDER_STAMP_META],
    ).toMatch(/^[0-9a-f]{32}$/);
  });

  it("the framework's materialiser renders the same objects from Release's catalog", async () => {
    const product = await loadProductPublic(db, OWNER);
    const catalog = packageCatalog({ db, slug: product!.slug });
    const res = await materialise(
      {
        bucket: asR2(bucket),
        renderers: RENDERERS,
        source: {
          package: async (owner, id) =>
            ociPackage(catalog, owner, { id, name: OCI_REPO }),
        },
        origin: PKG,
      },
      OWNER,
      OCI_ID,
    );
    expect(res.status).toBe("rendered");
    const refs = await bucket.get(
      registryObjectKey("oci", OWNER, `${OCI_REPO}/_refs.json`),
    );
    golden("refs.json", await (refs as R2ObjectBody).text());
    const tags = await bucket.get(
      registryObjectKey("oci", OWNER, `${OCI_REPO}/_tags.json`),
    );
    golden("tags.json", await (tags as R2ObjectBody).text());
  });

  it("tags/list paginates with n and last, and links the next page", async () => {
    const first = await get(`/v2/${NAME}/tags/list?n=2`);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      name: NAME,
      tags: ["0.8.0", "1.0.0"],
    });
    expect(first.headers.get("link")).toBe(
      `</v2/${NAME}/tags/list?n=2&last=1.0.0>; rel="next"`,
    );
    const second = await get(`/v2/${NAME}/tags/list?n=2&last=1.0.0`);
    expect(await second.json()).toEqual({
      name: NAME,
      tags: ["1.1.0-beta.1", "beta"],
    });
    const third = await get(`/v2/${NAME}/tags/list?n=2&last=beta`);
    // `dev` is built in and serves what its include chain serves (here beta's build).
    expect(await third.json()).toEqual({ name: NAME, tags: ["dev", "latest"] });
    expect(third.headers.get("link")).toBeNull();
    const after = await get(`/v2/${NAME}/tags/list?last=1.1.0-beta.1`);
    expect(await after.json()).toEqual({
      name: NAME,
      tags: ["beta", "dev", "latest"],
    });
    const none = await get(`/v2/${NAME}/tags/list?n=0`);
    expect(await none.json()).toEqual({ name: NAME, tags: [] });
    expect(MAX_TAGS_PAGE).toBe(1000);
  });

  it("a manifest by tag is an index document; by digest it is immutable; HEAD carries the headers", async () => {
    const root = ver("1.0.0").root;
    const byTag = await get(`/v2/${NAME}/manifests/latest`, {
      headers: { accept: `${OCI_MANIFEST}, ${OCI_INDEX}` },
    });
    hardened(byTag, "by tag");
    expect(byTag.status).toBe(200);
    expect(byTag.headers.get("content-type")).toBe(OCI_INDEX);
    expect(byTag.headers.get("docker-content-digest")).toBe(
      `sha256:${root.sha256}`,
    );
    expect(byTag.headers.get("content-length")).toBe(String(root.bytes.length));
    expect(byTag.headers.get("cache-control")).toBe(INDEX_CACHE_CONTROL);
    expect(byTag.headers.get("etag")).toBe(`"${root.sha256}"`);
    expect(new Uint8Array(await byTag.arrayBuffer())).toEqual(root.bytes);

    const byVersion = await get(`/v2/${NAME}/manifests/1.0.0`);
    expect(byVersion.headers.get("docker-content-digest")).toBe(
      `sha256:${root.sha256}`,
    );

    const byDigest = await get(`/v2/${NAME}/manifests/sha256:${root.sha256}`);
    expect(byDigest.status).toBe(200);
    expect(byDigest.headers.get("cache-control")).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(new Uint8Array(await byDigest.arrayBuffer())).toEqual(root.bytes);

    // A child manifest of the index, by digest.
    const child = ver("1.0.0").objects.find((o) => o.type === "oci-manifest")!;
    const c = await get(`/v2/${NAME}/manifests/sha256:${child.sha256}`);
    expect(c.status).toBe(200);
    expect(c.headers.get("content-type")).toBe(OCI_MANIFEST);

    const head = await get(`/v2/${NAME}/manifests/latest`, { method: "HEAD" });
    hardened(head, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("docker-content-digest")).toBe(
      `sha256:${root.sha256}`,
    );
    expect(head.headers.get("content-length")).toBe(String(root.bytes.length));
    expect(head.headers.get("content-type")).toBe(OCI_INDEX);
    expect(await head.text()).toBe("");
  });

  it("beta resolves the beta channel; the deprecated version is served", async () => {
    const beta = await get(`/v2/${NAME}/manifests/beta`);
    expect(beta.headers.get("docker-content-digest")).toBe(
      `sha256:${ver("1.1.0-beta.1").root.sha256}`,
    );
    const deprecated = await get(`/v2/${NAME}/manifests/0.8.0`);
    expect(deprecated.status).toBe(200);
    expect(deprecated.headers.get("content-type")).toBe(DOCKER_MANIFEST);
  });

  it("a yanked version has no tag, but its digest still pulls", async () => {
    const yanked = ver("0.9.0");
    const byTag = await get(`/v2/${NAME}/manifests/0.9.0`);
    hardened(byTag, "yanked tag");
    expect(byTag.status).toBe(404);
    expect(byTag.headers.get("cache-control")).toBe("no-store");
    expect(await ociCode(byTag)).toBe("MANIFEST_UNKNOWN");
    const byDigest = await get(
      `/v2/${NAME}/manifests/sha256:${yanked.root.sha256}`,
    );
    expect(byDigest.status).toBe(200);
    const layer = yanked.objects.find((o) => o.type === "oci-blob")!;
    expect((await get(`/v2/${NAME}/blobs/sha256:${layer.sha256}`)).status).toBe(
      200,
    );
  });

  it("a state change is served on the next read, with no drain (render-on-stale)", async () => {
    expect((await get(`/v2/${NAME}/tags/list`)).status).toBe(200);
    // Unyank 0.9.0 through Release's own path (it moves the package state and enqueues).
    const u = await unyank(
      env,
      db,
      OWNER,
      `${OCI_ID}@0.9.0`,
      { kind: "admin", session: { sub: "u1" } as AdminSession },
      NOW + 20,
    );
    expect(u.ok, JSON.stringify(u)).toBe(true);
    const after = await get(`/v2/${NAME}/tags/list`);
    expect(((await after.json()) as { tags: string[] }).tags).toContain(
      "0.9.0",
    );
    const stored = (await bucket.get(
      registryObjectKey("oci", OWNER, `${OCI_REPO}/_tags.json`),
    )) as R2ObjectBody;
    expect(JSON.parse(await stored.text()).tags).toContain("0.9.0");
  });

  it("refuses a manifest the client's Accept cannot take", async () => {
    const res = await get(`/v2/${NAME}/manifests/latest`, {
      headers: { accept: DOCKER_MANIFEST },
    });
    expect(res.status).toBe(404);
    expect(await ociCode(res)).toBe("MANIFEST_UNKNOWN");
  });

  it("blobs: whole, ranged (206), unsatisfiable (416), HEAD sizes, conditional", async () => {
    const layer = ver("1.0.0").objects.find((o) => o.type === "oci-blob")!;
    const path = `/v2/${NAME}/blobs/sha256:${layer.sha256}`;
    const whole = await get(path);
    hardened(whole, "blob");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("application/octet-stream");
    expect(whole.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(whole.headers.get("docker-content-digest")).toBe(
      `sha256:${layer.sha256}`,
    );
    expect(whole.headers.get("cache-control")).toMatch(
      /^public, max-age=31536000, immutable/,
    );
    expect(whole.headers.get("etag")).toBe(`"${layer.sha256}"`);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(layer.bytes);

    const ranged = await get(path, { headers: { range: "bytes=0-4" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(
      `bytes 0-4/${layer.bytes.length}`,
    );
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(
      layer.bytes.slice(0, 5),
    );

    const over = await get(path, { headers: { range: "bytes=9999-" } });
    expect(over.status).toBe(416);
    expect(over.headers.get("content-range")).toBe(
      `bytes */${layer.bytes.length}`,
    );

    const head = await get(path, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(layer.bytes.length));
    expect(head.headers.get("docker-content-digest")).toBe(
      `sha256:${layer.sha256}`,
    );

    const cond = await get(path, {
      headers: { "if-none-match": `"${layer.sha256}"` },
    });
    expect(cond.status).toBe(304);
  });

  it("blobs never enter the Cache API; manifests by tag do", async () => {
    const store = new Map<string, Response>();
    (globalThis as { caches?: unknown }).caches = {
      default: {
        match: async (r: Request) => store.get(r.url)?.clone(),
        put: async (r: Request, res: Response) => {
          store.set(r.url, res.clone());
        },
      },
    };
    const layer = ver("1.0.0").objects.find((o) => o.type === "oci-blob")!;
    expect((await get(`/v2/${NAME}/blobs/sha256:${layer.sha256}`)).status).toBe(
      200,
    );
    expect(
      (
        await get(`/v2/${NAME}/blobs/sha256:${layer.sha256}`, {
          headers: { range: "bytes=1-2" },
        })
      ).status,
    ).toBe(206);
    expect(store.size).toBe(0);
    expect((await get(`/v2/${NAME}/manifests/latest`)).status).toBe(200);
    expect(store.size).toBe(1);
  });

  it("unknown blobs, repositories, owners and malformed names answer OCI's not-found", async () => {
    const other = `sha256:${"0".repeat(64)}`;
    const cases: Array<[string, string]> = [
      [`/v2/${NAME}/blobs/${other}`, "BLOB_UNKNOWN"],
      [`/v2/${NAME}/blobs/sha512:abc`, "BLOB_UNKNOWN"],
      [`/v2/${NAME}/manifests/${other}`, "MANIFEST_UNKNOWN"],
      [`/v2/${NAME}/manifests/nope`, "MANIFEST_UNKNOWN"],
      [`/v2/${NAME}/manifests/bad%20ref`, "MANIFEST_UNKNOWN"],
      [`/v2/${OWNER}/tools/missing/tags/list`, "NAME_UNKNOWN"],
      [`/v2/${OWNER}/tools/missing/manifests/latest`, "NAME_UNKNOWN"],
      [`/v2/nobody/${OCI_REPO}/tags/list`, "NAME_UNKNOWN"],
      [`/v2/${OWNER}/Tools/App/tags/list`, "NAME_UNKNOWN"],
      ["/v2/token", "NAME_UNKNOWN"],
      ["/v2/_catalog", "NAME_UNKNOWN"],
    ];
    for (const [path, code] of cases) {
      const res = await get(path);
      hardened(res, path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await ociCode(res), path).toBe(code);
    }
  });

  it("a blob of another repository is not served from this one", async () => {
    // Publish nothing else: any digest outside the repository's files is unknown here, even
    // though the bucket holds it.
    await bucket.put("blobs/sha256/" + sha256("stray"), "stray", {
      sha256: sha256("stray"),
    });
    const res = await get(`/v2/${NAME}/blobs/sha256:${sha256("stray")}`);
    expect(res.status).toBe(404);
    expect(await ociCode(res)).toBe("BLOB_UNKNOWN");
  });

  it("a feed that is off reads as absent; a non-public feed answers the Bearer challenge", async () => {
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE product = ?",
      OWNER,
    );
    forgetRegistrySettings();
    const off = await get(`/v2/${NAME}/manifests/latest`);
    hardened(off, "off");
    expect(off.status).toBe(404);
    expect(await ociCode(off)).toBe("NAME_UNKNOWN");

    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 1, access_mode = 'licensed' WHERE product = ?",
      OWNER,
    );
    forgetRegistrySettings();
    for (const path of [
      `/v2/${NAME}/manifests/latest`,
      `/v2/${NAME}/blobs/sha256:${ver("1.0.0").root.sha256}`,
      `/v2/${NAME}/tags/list`,
    ]) {
      const res = await get(path);
      hardened(res, path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(res.headers.get("www-authenticate"), path).toBe(
        `Bearer realm="${PKG}/v2/token",service="pkg.example.test",scope="repository:${NAME}:pull"`,
      );
      expect(await ociCode(res), path).toBe("UNAUTHORIZED");
    }
  });

  it("Release off for the owner reads as an unknown repository", async () => {
    await setServices(
      db,
      OWNER,
      serializeServices({
        services: { ...ON, release: { enabled: false } },
      }),
      "manifest",
      NOW,
    );
    const res = await get(`/v2/${NAME}/tags/list`);
    expect(res.status).toBe(404);
    expect(await ociCode(res)).toBe("NAME_UNKNOWN");
  });

  it("delete is never answered (405 UNSUPPORTED); a push without a push token is 401 (F-23, test/registryPush.test.ts)", async () => {
    for (const [method, path] of [
      ["DELETE", `/v2/${NAME}/manifests/latest`],
      ["DELETE", `/v2/${NAME}/blobs/sha256:${"a".repeat(64)}`],
      ["POST", `/v2/${NAME}/manifests/latest`],
    ] as const) {
      const res = await get(path, { method });
      hardened(res, `${method} ${path}`);
      expect(res.status).toBe(405);
      expect(await ociCode(res)).toBe("UNSUPPORTED");
    }
    for (const [method, path] of [
      ["PUT", `/v2/${NAME}/manifests/latest`],
      ["POST", `/v2/${NAME}/blobs/uploads/`],
      ["PATCH", `/v2/${NAME}/blobs/uploads/x`],
    ] as const) {
      const res = await get(path, { method });
      hardened(res, `${method} ${path}`);
      expect(res.status).toBe(401);
      expect(await ociCode(res)).toBe("UNAUTHORIZED");
    }
  });

  it("every success type is on the host's allowlist", async () => {
    const stamp = await renderStamp(ociFixturePackage(OWNER));
    expect(stamp).toMatch(/^[0-9a-f]{32}$/);
    for (const path of [
      `/v2/${NAME}/tags/list`,
      `/v2/${NAME}/manifests/latest`,
      `/v2/${NAME}/manifests/0.8.0`,
      `/v2/${NAME}/blobs/sha256:${ver("1.0.0").root.sha256}`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect([
        "application/json",
        OCI_INDEX,
        OCI_MANIFEST,
        DOCKER_MANIFEST,
        "application/octet-stream",
      ]).toContain(res.headers.get("content-type"));
    }
  });
});
