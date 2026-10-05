/**
 * F-06 — the Swift package registry feed (plans/F-01.md §5.3, §6.7, §6.8; SwiftPM `Registry.md`).
 *
 *   1. Golden files for every rendered document (`render.ts`), from a fixture with a stable, a
 *      beta, a yanked and a deprecated version. The goldens are prettier-formatted JSON under
 *      `test/fixtures/registry-swift/`; re-serialising one with `JSON.stringify` keeps key order,
 *      so text equality is byte equality with the rendered body. Regenerate with
 *      `UPDATE_GOLDEN=1` and run prettier on the directory; a change is a protocol change.
 *   2. The routes through the real dispatcher on the registry host, over packages published
 *      through the real submit route: headers, negotiation, errors, links, signatures, yank,
 *      deprecate and channel behaviour, and that every read goes through the access ladder.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseManifest } from "@polaris-key/manifest";
import { makeTestDb, NO_HOOKS } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { NOW } from "./seed.js";
import { asR2, installDigestStream, R2Mock } from "./r2Mock.js";
import {
  admin,
  call,
  CONSOLE,
  envFor,
  seedReleaseProduct,
  SLUG,
} from "./releaseRoutesFixture.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import { issueStaticCiToken } from "../src/core/publisher.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { releaseCatalog } from "../src/services/release/catalog.js";
import { getProduct } from "../src/repo.js";
import { REGISTRY_ROUTES } from "../src/mount.js";
import { REGISTRY_CSP } from "../src/core/registryHost.js";
import { blobKey } from "../src/core/blobs.js";
import {
  materialise,
  type RegistryPackage,
} from "../src/services/distribution/registry/materialise.js";
import {
  byPrecedence,
  declaredToolsVersion,
  latestVersion,
  renderSwift,
} from "../src/services/distribution/registry/swift/render.js";
import {
  normaliseRepositoryUrl,
  swiftAcceptRefusal,
} from "../src/services/distribution/registry/swift/protocol.js";
import { catalogPackageSource } from "../src/services/distribution/registry/catalogSource.js";
import { SWIFT_RENDERER } from "../src/services/distribution/registry/swift/index.js";
import { forgetRegistrySettings } from "../src/services/distribution/registry/settings.js";

installDigestStream();

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(HERE, "fixtures", "registry-swift");
const PKG = "https://pkg.example.test";
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string) => new TextEncoder().encode(s);

// ── Fixture bytes: one archive, one signature and two signed manifests per version ───────────

const MANIFEST = (tools: string, v: string) =>
  enc(
    `// swift-tools-version:${tools}\nimport PackageDescription\nlet package = Package(name: "AcmeKit") // ${v}\n\n// signature: cms-1.0.0;FIXTURE${v}\n`,
  );

interface VersionBytes {
  zip: Uint8Array;
  sig: Uint8Array;
  manifest: Uint8Array;
  manifest6: Uint8Array;
}

function bytesFor(v: string): VersionBytes {
  return {
    zip: enc(`swift source archive for acme.AcmeKit ${v}`),
    sig: enc(`CMS signature bytes for ${v}`),
    manifest: MANIFEST("5.9", v),
    manifest6: MANIFEST("6.0", v),
  };
}

function filesFor(v: string, b: VersionBytes, signed = true) {
  const f = (
    name: string,
    type: string,
    bytes: Uint8Array,
  ): Record<string, unknown> => ({
    name,
    role: "payload",
    type,
    sha256: sha(bytes),
    size: bytes.length,
    locations: [{ provider: "r2", key: `blobs/sha256/${sha(bytes)}` }],
  });
  return [
    f(`acme.AcmeKit-${v}.zip`, "source-archive", b.zip),
    ...(signed
      ? [f(`acme.AcmeKit-${v}.sig`, "source-archive-signature", b.sig)]
      : []),
    f("Package.swift", "manifest", b.manifest),
    f("Package@swift-6.0.swift", "manifest", b.manifest6),
  ];
}

// ── 1. Golden files ───────────────────────────────────────────────────────────────────────────

const PUBLISHED = 1_790_000_000;

function fixturePackage(): RegistryPackage {
  const version = (
    v: string,
    state: "live" | "yanked" | "deprecated",
    stateMessage: string | null,
    i: number,
  ) => {
    const b = bytesFor(v);
    return {
      version: v,
      state,
      stateMessage,
      files: filesFor(v, b).map((f) => ({
        name: f.name as string,
        type: f.type as string,
        sha256: f.sha256 as string,
        size: f.size as number,
      })),
      metadata: {
        name: "acme.AcmeKit",
        version: v,
        toolsVersions: ["6.0"],
        signatureFormat: "cms-1.0.0",
      },
      publishedAt: PUBLISHED + i * 86_400,
    };
  };
  return {
    product: SLUG,
    ecosystem: "swift",
    deliverableId: "swift.kit",
    name: "acme.AcmeKit",
    nameNorm: "acme.acmekit",
    versions: [
      version("1.0.0", "live", null, 0),
      version("1.1.0", "yanked", "broken build", 1),
      version("1.2.0", "deprecated", "use 2.x", 2),
      version("2.0.0-beta.1", "live", null, 3),
    ],
    tags: { latest: "1.2.0", beta: "2.0.0-beta.1" },
  };
}

function fixtureBucket(): R2Mock {
  const r2 = new R2Mock();
  for (const v of ["1.0.0", "1.1.0", "1.2.0", "2.0.0-beta.1"]) {
    const b = bytesFor(v);
    for (const bytes of [b.zip, b.sig, b.manifest, b.manifest6])
      r2.seed(blobKey(sha(bytes)), bytes, { withSha256: true });
  }
  return r2;
}

function goldenName(key: string): string {
  return `${key.replace(/\//g, "__")}`;
}

describe("Swift renderer: golden files", () => {
  it("renders the list, each release's metadata and the routing record", async () => {
    const objects = await renderSwift(fixturePackage(), {
      origin: PKG,
      bucket: asR2(fixtureBucket()),
    });
    expect(objects.map((o) => o.key)).toEqual([
      "acme.acmekit/releases.json",
      "acme.acmekit/routing.json",
      "acme.acmekit/2.0.0-beta.1.json",
      "acme.acmekit/1.2.0.json",
      "acme.acmekit/1.1.0.json",
      "acme.acmekit/1.0.0.json",
    ]);
    for (const o of objects) {
      expect(o.contentType, o.key).toBe("application/json");
      const file = join(GOLDEN_DIR, goldenName(o.key));
      const body = o.body as string;
      if (process.env.UPDATE_GOLDEN)
        writeFileSync(file, `${JSON.stringify(JSON.parse(body), null, 2)}\n`);
      const golden = JSON.stringify(JSON.parse(readFileSync(file, "utf8")));
      expect(body, o.key).toBe(golden);
    }
  });

  it("orders by semver precedence; latest-version follows the latest tag, else the highest stable", () => {
    const pkg = fixturePackage();
    expect(byPrecedence(pkg.versions).map((v) => v.version)).toEqual([
      "2.0.0-beta.1",
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
    expect(latestVersion(pkg)).toBe("1.2.0");
    // A yanked tag head is never named: the highest available stable version is.
    expect(latestVersion({ ...pkg, tags: { latest: "1.1.0" } })).toBe("1.2.0");
    expect(latestVersion({ ...pkg, tags: {} })).toBe("1.2.0");
    // Only a prerelease left: it is the latest.
    expect(
      latestVersion({
        ...pkg,
        versions: pkg.versions.filter((v) => v.version === "2.0.0-beta.1"),
        tags: {},
      }),
    ).toBe("2.0.0-beta.1");
    expect(
      latestVersion({
        ...pkg,
        versions: pkg.versions.filter((v) => v.state === "yanked"),
        tags: {},
      }),
    ).toBeNull();
  });

  it("reads a manifest's declared tools version", () => {
    expect(declaredToolsVersion("// swift-tools-version:5.9\nimport")).toBe(
      "5.9",
    );
    expect(declaredToolsVersion("// swift-tools-version: 6.0.1\n")).toBe(
      "6.0.1",
    );
    expect(declaredToolsVersion("\uFEFF//swift-tools-version:6.0")).toBe("6.0");
    expect(declaredToolsVersion("import PackageDescription")).toBeUndefined();
  });

  it("fails the render when a signed version's signature cannot be read", async () => {
    await expect(
      renderSwift(fixturePackage(), {
        origin: PKG,
        bucket: asR2(new R2Mock()),
      }),
    ).rejects.toThrow(/signature/);
  });
});

describe("Swift protocol helpers", () => {
  const acc = (accept: string | null, want: "json" | "zip" | "swift") =>
    swiftAcceptRefusal(
      new Request(PKG, accept === null ? {} : { headers: { accept } }),
      want,
    )?.status ?? null;

  it("Accept: 400 for an invalid version or media type, 415 for an unsupported one (§3.5)", () => {
    expect(acc(null, "json")).toBeNull();
    expect(acc("*/*", "json")).toBeNull();
    expect(acc("application/json", "json")).toBeNull();
    expect(acc("application/vnd.swift.registry.v1+json", "json")).toBeNull();
    expect(acc("application/vnd.swift.registry.v1+zip", "zip")).toBeNull();
    expect(acc("application/vnd.swift.registry.v1+swift", "swift")).toBeNull();
    expect(acc("application/vnd.swift.registry.v1", "json")).toBeNull();
    expect(acc("application/vnd.swift.registry+json", "json")).toBeNull();
    expect(acc("application/vnd.swift.registry.vX+json", "json")).toBe(400);
    expect(acc("application/vnd.swift.registry.v1+xml", "json")).toBe(400);
    expect(acc("application/vnd.swift.registry.v2+json", "json")).toBe(415);
    expect(acc("application/vnd.swift.registry.v1+zip", "json")).toBe(415);
    // One acceptable registry range among others is enough.
    expect(
      acc(
        "application/vnd.swift.registry.v2+json, application/vnd.swift.registry.v1+json",
        "json",
      ),
    ).toBeNull();
  });

  it("normalises repository URLs for /identifiers", () => {
    const n = "github.com/mona/linkedlist";
    for (const u of [
      "https://github.com/mona/LinkedList",
      "https://github.com/mona/LinkedList.git",
      "HTTPS://GITHUB.COM/MONA/LINKEDLIST/",
      "git@github.com:mona/LinkedList.git",
      "ssh://git@github.com/mona/LinkedList",
    ])
      expect(normaliseRepositoryUrl(u), u).toBe(n);
    expect(normaliseRepositoryUrl("https://host:8443/a/b")).toBe(
      "host:8443/a/b",
    );
    expect(normaliseRepositoryUrl("  ")).toBeNull();
  });
});

// ── 2. The routes, end to end ────────────────────────────────────────────────────────────────

const R2_ENV = {
  R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  R2_PARENT_ACCESS_KEY_ID: "parent-akid",
  R2_PARENT_SECRET_ACCESS_KEY: "parent-secret",
  BLOBS_BUCKET_NAME: "polaris-key-blobs-test",
};
const noFetch: FetchImpl = async () => new Response("nf", { status: 404 });

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
      "swift.kit": {
        kind: "package",
        ecosystem: "swift",
        name: "acme.AcmeKit",
        artifacts: { archive: { match: "*.zip" } },
      },
      "swift.other": {
        kind: "package",
        ecosystem: "swift",
        name: "acme.Other",
        artifacts: { archive: { match: "*.zip" } },
      },
    },
  },
};

let db: Db;
let env: Env;
let r2: R2Mock;
let token: string;

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
  const parsed = parseManifest({
    product: JSON.stringify({ slug: SLUG, name: "djdl" }),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(RELEASE_DOC),
  });
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  const rel = parsed.manifest.release!;
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
    `INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)`,
    SLUG,
    NOW,
  );
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, 'swift', 1, ?, 52428800, ?, ?)`,
    SLUG,
    JSON.stringify({ scope: "acme" }),
    JSON.stringify({
      requireSigned: true,
      repositoryUrls: {
        "acme.AcmeKit": ["https://github.com/acme/AcmeKit.git"],
        "acme.Missing": ["https://github.com/acme/AcmeKit"],
      },
    }),
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
});

afterEach(() => {
  vi.useRealTimers();
});

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

async function publishSwift(
  version: string,
  channel = "stable",
): Promise<VersionBytes> {
  const b = bytesFor(version);
  const blobs = [b.zip, b.sig, b.manifest, b.manifest6];
  const up = await post("uploads", {
    objects: blobs.map((f) => ({ sha256: sha(f), size: f.length })),
  });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { ticket: string; prefix: string };
  for (const f of blobs)
    r2.seed(`${u.prefix}${sha(f)}`, f, { withSha256: true });
  const res = await post("submit", {
    ticket: u.ticket,
    descriptor: {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: "swift.kit",
      kind: "package",
      version,
      channel,
      package: {
        ecosystem: "swift",
        name: "acme.AcmeKit",
        files: filesFor(version, b),
        metadata: {
          name: "acme.AcmeKit",
          version,
          toolsVersions: ["6.0"],
          signatureFormat: "cms-1.0.0",
        },
      },
    },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return b;
}

function get(
  path: string,
  accept: string | null = "application/vnd.swift.registry.v1+json",
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (accept !== null) headers.set("accept", accept);
  return call(env, db, noFetch, `${PKG}${path}`, { ...init, headers });
}

const BASE = `/swift/${SLUG}`;

function expectSwift(res: Response, at: string): void {
  expect(res.headers.get("content-version"), at).toBe("1");
  expect(res.headers.get("x-content-type-options"), at).toBe("nosniff");
  expect(res.headers.get("content-security-policy"), at).toBe(REGISTRY_CSP);
  expect(res.headers.get("set-cookie"), at).toBeNull();
  expect(res.headers.get("access-control-allow-origin"), at).toBeNull();
}

async function expectNotFound(res: Response, at: string): Promise<void> {
  expect(res.status, at).toBe(404);
  expect(res.headers.get("content-type"), at).toBe("application/problem+json");
  expect(res.headers.get("cache-control"), at).toBe("no-store");
  expectSwift(res, at);
  expect(await res.json(), at).toEqual({ detail: "not found" });
}

/** The package's documents re-rendered from D1, as the drain does after a change. */
async function rerender(): Promise<void> {
  const product = (await getProduct(db, SLUG))!;
  const catalog = releaseCatalog({
    db,
    env,
    product: product as never,
    now: NOW,
    hooks: NO_HOOKS,
  } as never);
  await materialise(
    {
      bucket: env.BLOBS!,
      renderers: new Map([["swift", SWIFT_RENDERER]]),
      source: catalogPackageSource(catalog, SLUG, "swift"),
      origin: PKG,
    },
    SLUG,
    "swift.kit",
  );
}

describe("Swift registry routes (F-06)", () => {
  it("registers its routes, all Distribution's, under the swift ecosystem", () => {
    const swift = REGISTRY_ROUTES.filter((r) => r.ecosystem === "swift");
    expect(swift.map((r) => r.name)).toEqual([
      "swift.identifiers",
      "swift.manifest",
      "swift.archive",
      "swift.release",
      "swift.releases",
      // F-21: SwiftPM's login, a credential route.
      "swift.login",
    ]);
    for (const r of swift) expect(r.service).toBe("distribution");
  });

  it("lists releases with a yanked problem, latest-version link and Content-Version (§4.1)", async () => {
    await publishSwift("1.0.0");
    await publishSwift("1.1.0");
    await publishSwift("1.2.0");
    await publishSwift("2.0.0-beta.1", "beta");
    const id = encodeURIComponent("swift.kit@1.1.0");
    expect(
      (
        await admin(env, db, "POST", `/releases/${id}/yank`, {
          reason: "broken build",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin(
          env,
          db,
          "POST",
          `/releases/${encodeURIComponent("swift.kit@1.2.0")}/deprecate`,
          { message: "use 2.x" },
        )
      ).status,
    ).toBe(200);

    for (const path of [
      `${BASE}/acme/AcmeKit`,
      `${BASE}/ACME/acmekit`,
      `${BASE}/acme/AcmeKit.json`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expectSwift(res, path);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("cache-control")).toBe(
        "public, max-age=60, stale-while-revalidate=60",
      );
      expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
      expect(res.headers.get("link")).toBe(
        `<${PKG}${BASE}/acme/AcmeKit/1.2.0>; rel="latest-version"`,
      );
      expect(await res.json()).toEqual({
        releases: {
          "2.0.0-beta.1": {},
          "1.2.0": {},
          "1.1.0": {
            problem: {
              status: 410,
              title: "Gone",
              detail: "this release was yanked from the registry",
            },
          },
          "1.0.0": {},
        },
      });
    }

    // Unyank, then the drain's re-render: the list shows it available again.
    expect(
      (await admin(env, db, "DELETE", `/releases/${id}/yank`)).status,
    ).toBe(200);
    await rerender();
    const after = (await (await get(`${BASE}/acme/AcmeKit`)).json()) as {
      releases: Record<string, unknown>;
    };
    expect(after.releases["1.1.0"]).toEqual({});
  });

  it("serves release metadata with the signature, checksum and version links (§4.2)", async () => {
    const b1 = await publishSwift("1.0.0");
    await publishSwift("1.1.0");
    await publishSwift("2.0.0-beta.1", "beta");
    // The compatibility suite flips the case of the whole path, the version included.
    const flipped = await get(`${BASE}/ACME/aCMEkIT/2.0.0-BETA.1`);
    expect(flipped.status).toBe(200);
    expect(((await flipped.json()) as { version: string }).version).toBe(
      "2.0.0-beta.1",
    );
    for (const path of [
      `${BASE}/acme/AcmeKit/1.1.0`,
      `${BASE}/acme/acmekit/1.1.0.json`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expectSwift(res, path);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("link")).toBe(
        [
          `<${PKG}${BASE}/acme/AcmeKit/1.1.0>; rel="latest-version"`,
          `<${PKG}${BASE}/acme/AcmeKit/1.0.0>; rel="predecessor-version"`,
          `<${PKG}${BASE}/acme/AcmeKit/2.0.0-beta.1>; rel="successor-version"`,
        ].join(", "),
      );
    }
    const doc = (await (await get(`${BASE}/acme/AcmeKit/1.0.0`)).json()) as {
      id: string;
      version: string;
      resources: Array<Record<string, unknown>>;
      metadata: unknown;
      publishedAt: string;
    };
    expect(doc).toEqual({
      id: "acme.AcmeKit",
      version: "1.0.0",
      resources: [
        {
          name: "source-archive",
          type: "application/zip",
          checksum: sha(b1.zip),
          signing: {
            signatureBase64Encoded: Buffer.from(b1.sig).toString("base64"),
            signatureFormat: "cms-1.0.0",
          },
        },
      ],
      metadata: {},
      publishedAt: new Date(NOW * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    await expectNotFound(await get(`${BASE}/acme/AcmeKit/9.9.9`), "unknown");
  });

  it("serves the signed manifests as text/x-swift with alternates; swift-version selects or 303s (§4.3)", async () => {
    const b = await publishSwift("1.0.0");
    const accept = "application/vnd.swift.registry.v1+swift";
    const res = await get(`${BASE}/acme/AcmeKit/1.0.0/Package.swift`, accept);
    expect(res.status).toBe(200);
    expectSwift(res, "manifest");
    expect(res.headers.get("content-type")).toBe("text/x-swift");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="Package.swift"',
    );
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(res.headers.get("content-length")).toBe(String(b.manifest.length));
    expect(res.headers.get("link")).toBe(
      `<${PKG}${BASE}/acme/AcmeKit/1.0.0/Package.swift?swift-version=6.0>; rel="alternate"; filename="Package@swift-6.0.swift"; swift-tools-version="6.0"`,
    );
    // The SIGNED copy the CLI uploaded, byte for byte.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(b.manifest);

    const six = await get(
      `${BASE}/acme/AcmeKit/1.0.0/Package.swift?swift-version=6.0`,
      accept,
    );
    expect(six.status).toBe(200);
    expectSwift(six, "manifest 6.0");
    expect(six.headers.get("content-disposition")).toBe(
      'attachment; filename="Package@swift-6.0.swift"',
    );
    expect(new Uint8Array(await six.arrayBuffer())).toEqual(b.manifest6);

    const other = await get(
      `${BASE}/acme/AcmeKit/1.0.0/Package.swift?swift-version=4.2`,
      accept,
    );
    expect(other.status).toBe(303);
    expectSwift(other, "303");
    expect(other.headers.get("location")).toBe(
      `${PKG}${BASE}/acme/AcmeKit/1.0.0/Package.swift`,
    );
    await expectNotFound(
      await get(`${BASE}/acme/AcmeKit/9.9.9/Package.swift`, accept),
      "unknown manifest",
    );
  });

  it("serves the archive with the signature headers, ranges and the integrity checksum (§4.4)", async () => {
    const b = await publishSwift("1.0.0");
    const accept = "application/vnd.swift.registry.v1+zip";
    const res = await get(`${BASE}/acme/AcmeKit/1.0.0.zip`, accept);
    expect(res.status).toBe(200);
    expectSwift(res, "zip");
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="AcmeKit-1.0.0.zip"',
    );
    expect(res.headers.get("content-length")).toBe(String(b.zip.length));
    expect(res.headers.get("etag")).toBe(`"${sha(b.zip)}"`);
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable, no-transform",
    );
    expect(res.headers.get("x-swift-package-signature-format")).toBe(
      "cms-1.0.0",
    );
    expect(res.headers.get("x-swift-package-signature")).toBe(
      Buffer.from(b.sig).toString("base64"),
    );
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(sha(b.zip));

    const head = await get(`${BASE}/acme/AcmeKit/1.0.0.zip`, accept, {
      method: "HEAD",
    });
    expect(head.status).toBe(200);
    expectSwift(head, "zip HEAD");
    expect(head.headers.get("content-length")).toBe(String(b.zip.length));

    const range = await get(`${BASE}/acme/AcmeKit/1.0.0.zip`, accept, {
      headers: { range: "bytes=0-4" },
    });
    expect(range.status).toBe(206);
    expectSwift(range, "zip range");
    expect(new TextDecoder().decode(await range.arrayBuffer())).toBe("swift");

    const cond = await get(`${BASE}/acme/AcmeKit/1.0.0.zip`, accept, {
      headers: { "if-none-match": `"${sha(b.zip)}"` },
    });
    expect(cond.status).toBe(304);
    expectSwift(cond, "zip 304");

    await expectNotFound(
      await get(`${BASE}/acme/AcmeKit/9.9.9.zip`, accept),
      "unknown zip",
    );
  });

  it("keeps a yanked version's metadata, manifest and archive served (TOFU: never changes)", async () => {
    await publishSwift("1.0.0");
    await admin(
      env,
      db,
      "POST",
      `/releases/${encodeURIComponent("swift.kit@1.0.0")}/yank`,
      { reason: "bad" },
    );
    expect((await get(`${BASE}/acme/AcmeKit/1.0.0`)).status).toBe(200);
    expect(
      (
        await get(
          `${BASE}/acme/AcmeKit/1.0.0.zip`,
          "application/vnd.swift.registry.v1+zip",
        )
      ).status,
    ).toBe(200);
    const list = (await (await get(`${BASE}/acme/AcmeKit`)).json()) as {
      releases: Record<string, { problem?: unknown }>;
    };
    expect(list.releases["1.0.0"]!.problem).toBeDefined();
    // No available release: no latest-version link.
    expect((await get(`${BASE}/acme/AcmeKit`)).headers.get("link")).toBeNull();
  });

  it("checks Accept before anything else: 400 and 415 as problem documents", async () => {
    await publishSwift("1.0.0");
    const bad = await get(
      `${BASE}/acme/AcmeKit`,
      "application/vnd.swift.registry.vX+json",
    );
    expect(bad.status).toBe(400);
    expectSwift(bad, "400");
    expect(bad.headers.get("content-type")).toBe("application/problem+json");
    expect(await bad.json()).toEqual({ detail: "invalid API version" });
    const unsupported = await get(
      `${BASE}/acme/AcmeKit`,
      "application/vnd.swift.registry.v2+json",
    );
    expect(unsupported.status).toBe(415);
    expectSwift(unsupported, "415");
    expect(await unsupported.json()).toEqual({
      detail: "unsupported API version",
    });
    // A wrong media type for the endpoint is unsupported too.
    expect(
      (
        await get(
          `${BASE}/acme/AcmeKit/1.0.0.zip`,
          "application/vnd.swift.registry.v1+json",
        )
      ).status,
    ).toBe(415);
    // No Accept at all is served as version 1.
    expect((await get(`${BASE}/acme/AcmeKit`, null)).status).toBe(200);
  });

  it("answers the one not-found for an unknown package, owner, feed off, or a bad name", async () => {
    await publishSwift("1.0.0");
    await expectNotFound(await get(`${BASE}/acme/Nope`), "unknown package");
    await expectNotFound(await get(`${BASE}/acme/Other`), "declared, none");
    await expectNotFound(await get(`/swift/nobody/acme/AcmeKit`), "owner");
    await expectNotFound(await get(`${BASE}/-bad/AcmeKit`), "bad scope");
    await expectNotFound(await get(`${BASE}/acme/AcmeKit/x/y/z`), "deep");
    await db.run(
      "UPDATE dist_registry_feeds SET enabled = 0 WHERE product = ? AND ecosystem = 'swift'",
      SLUG,
    );
    forgetRegistrySettings();
    await expectNotFound(await get(`${BASE}/acme/AcmeKit`), "feed off");
  });

  it("a non-public feed answers Basic 401 problem+json, private and uncached", async () => {
    await publishSwift("1.0.0");
    await db.run(
      "UPDATE dist_registry_feeds SET access_mode = 'licensed' WHERE product = ? AND ecosystem = 'swift'",
      SLUG,
    );
    forgetRegistrySettings();
    const res = await get(`${BASE}/acme/AcmeKit`);
    expect(res.status).toBe(401);
    expectSwift(res, "401");
    expect(res.headers.get("www-authenticate")).toBe(
      'Basic realm="pkg.example.test"',
    );
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("looks up identifiers by repository URL from the feed's repositoryUrls (§4.5)", async () => {
    await publishSwift("1.0.0");
    for (const url of [
      "https://github.com/acme/AcmeKit",
      "https://GITHUB.com/ACME/acmekit.git",
      "git@github.com:acme/AcmeKit.git",
    ]) {
      const res = await get(
        `${BASE}/identifiers?url=${encodeURIComponent(url)}`,
      );
      expect(res.status, url).toBe(200);
      expectSwift(res, url);
      expect(res.headers.get("content-type")).toBe("application/json");
      // acme.Missing is claimed too but is not a package of the feed: never listed.
      expect(await res.json()).toEqual({ identifiers: ["acme.AcmeKit"] });
    }
    await expectNotFound(
      await get(
        `${BASE}/identifiers?url=${encodeURIComponent("https://github.com/other/x")}`,
      ),
      "unknown url",
    );
    const missing = await get(`${BASE}/identifiers`);
    expect(missing.status).toBe(400);
    expectSwift(missing, "no url");
    expect(missing.headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });

  it("login checks a registry token (F-21) and publish is 405 until F-22, decided before any owner is loaded", async () => {
    // An unknown owner's login is the host's not-found; this owner's without a token is 401.
    const unknown = await get(`/swift/nobody/login`, null, { method: "POST" });
    expect(unknown.status).toBe(404);
    expectSwift(unknown, "login nobody");
    const login = await get(`/swift/${SLUG}/login`, null, { method: "POST" });
    expect(login.status).toBe(401);
    expectSwift(login, `login ${SLUG}`);
    expect(login.headers.get("content-type")).toBe("application/problem+json");
    expect(login.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    // GET on the login path is no route at all.
    expect((await get(`/swift/${SLUG}/login`)).status).toBe(404);
    for (const owner of [SLUG, "nobody"]) {
      const put = await get(`/swift/${owner}/acme/AcmeKit/1.0.0`, null, {
        method: "PUT",
      });
      expect(put.status, owner).toBe(405);
      expectSwift(put, `put ${owner}`);
      expect(put.headers.get("allow")).toBe("GET, HEAD");
    }
    const options = await get(`${BASE}/acme/AcmeKit`, null, {
      method: "OPTIONS",
    });
    expect(options.status).toBe(405);
    expectSwift(options, "options");
  });

  it("renders a lost document again on the read", async () => {
    await publishSwift("1.0.0");
    expect((await get(`${BASE}/acme/AcmeKit`)).status).toBe(200);
    const key = `registry/swift/${SLUG}/acme.acmekit/releases.json`;
    expect(await r2.head(key)).not.toBeNull();
    await r2.delete(key);
    expect((await get(`${BASE}/acme/AcmeKit/1.0.0`)).status).toBe(200);
    expect((await get(`${BASE}/acme/AcmeKit`)).status).toBe(200);
    expect(await r2.head(key)).not.toBeNull();
  });

  // v0.8.19: the stable release stayed off the list for the whole feed-drift window, because the
  // stored render predated the publish and no drain had run yet. Every document is stamp-checked
  // against D1 on the read, as Maven's, npm's, PyPI's and Godot's are.
  it("serves a version published after the last render without waiting for a drain", async () => {
    await publishSwift("1.0.0-beta.1", "beta");
    expect((await get(`${BASE}/acme/AcmeKit`)).status).toBe(200);
    await publishSwift("1.0.0");
    // No rerender(): the stored list and routing record predate 1.0.0.
    const list = await get(`${BASE}/acme/AcmeKit`);
    expect(list.status).toBe(200);
    expect(list.headers.get("link")).toBe(
      `<${PKG}${BASE}/acme/AcmeKit/1.0.0>; rel="latest-version"`,
    );
    expect(await list.json()).toEqual({
      releases: { "1.0.0": {}, "1.0.0-beta.1": {} },
    });
    const meta = await get(`${BASE}/acme/AcmeKit/1.0.0`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as { version: string }).version).toBe("1.0.0");
    const manifest = await get(
      `${BASE}/acme/AcmeKit/1.0.0/Package.swift`,
      "application/vnd.swift.registry.v1+swift",
    );
    expect(manifest.status).toBe(200);
  });
});
