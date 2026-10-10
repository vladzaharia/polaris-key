/**
 * The Go module proxy (F-31, plans/F-01.md §6.7, §6.8) through the real registry host: the
 * rendered `@v/list`, `@latest` and `.info` documents (golden files), the `.mod` and `.zip` bytes
 * by digest, the headers of §6.7 on every answer, the case-encoded paths, yank and channel
 * behaviour, and the access ladder in front of all of it.
 *
 * The fixture is published through Release's real package ingest and yanked through Release's
 * real policy function: `go.acme.dev/Sdk` (an upper-case element, so every URL is case-encoded)
 * at v1.0.0, v1.0.1 (yanked), v1.1.0 (the stable head) and v1.2.0-beta.1 (the `beta` channel).
 *
 * Regenerate the goldens with `UPDATE_FEED_GOLDENS=1` after an intended change, and review the
 * diff: they are what the go command reads.
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
} from "../../src/core/registry/registryHost.js";
import { blobKey, recordObject } from "../../src/core/assets/blobs.js";
import {
  serializeServices,
  type ServicesMap,
} from "../../src/core/services.js";
import { setServices } from "../../src/core/repo.js";
import { stmtUpsertDeliverable } from "../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../src/services/release/packages/ingest.js";
import { yank, type PolicyActor } from "../../src/services/release/policy.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  goEscape,
  goTime,
  goUnescape,
  renderGo,
} from "../../src/services/distribution/registry/go/render.js";
import type { RegistryPackage } from "../../src/services/distribution/registry/materialise.js";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { R2Mock, asR2 } from "../r2Mock.js";
import { makeEnv, NOW, seedProduct } from "../seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "..", "fixtures", "registry", "go");
const PKG = "https://pkg.example.test";
const OWNER = "acme";
const MODULE = "go.acme.dev/Sdk";
const DELIVERABLE = "go.sdk";
/** The module's base URL, case-encoded as the go command sends it. */
const BASE = `/go/${OWNER}/go.acme.dev/!sdk`;

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

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

let db: Db;
let env: Env;
let r2: R2Mock;
/** The bytes published, by `<version>/<file>`. */
const published = new Map<string, Uint8Array>();

async function store(bytes: Uint8Array, at: number): Promise<string> {
  const digest = sha256(bytes);
  await asR2(r2).put(blobKey(digest), bytes, { sha256: digest });
  await recordObject(
    db,
    {
      storageKey: blobKey(digest),
      sha256: digest,
      size: bytes.length,
      kind: "blob",
      gated: false,
    },
    at,
  );
  return digest;
}

async function publish(
  version: string,
  channel: string,
  at: number,
): Promise<void> {
  // The bytes only need to be distinct per version: the Worker never unzips.
  const zip = enc.encode(`module zip of ${MODULE}@v${version}`);
  const mod = enc.encode(`module ${MODULE}\n\ngo 1.22\n// ${version}\n`);
  published.set(`${version}/zip`, zip);
  published.set(`${version}/mod`, mod);
  const zipSha = await store(zip, at);
  const modSha = await store(mod, at);
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
        ecosystem: "go",
        name: MODULE,
        files: [
          {
            name: `v${version}.zip`,
            role: "payload",
            type: "go-zip",
            sha256: zipSha,
            size: zip.length,
            locations: [{ provider: "r2", key: blobKey(zipSha) }],
          },
          {
            name: "go.mod",
            role: "payload",
            type: "go-mod",
            sha256: modSha,
            size: mod.length,
            locations: [{ provider: "r2", key: blobKey(modSha) }],
          },
        ],
        metadata: {
          name: MODULE,
          version,
          h1: `h1:${version}`,
          goModH1: `h1:mod-${version}`,
          goVersion: "1.22",
        },
      },
    },
    {
      now: at,
      promoted: [blobKey(zipSha), blobKey(modSha)],
      feed: {
        ecosystem: "go",
        enabled: true,
        ownerEnabled: true,
        policyEnabled: true,
        namespace: { modulePrefixes: ["go.acme.dev"] },
        maxPackageBytes: 52428800,
        ext: {},
      },
      source: { kind: "static" },
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
     VALUES (?, 'go', ?, ?, ?, 52428800, ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET enabled = excluded.enabled,
       access_mode = excluded.access_mode`,
    OWNER,
    over.enabled ?? 1,
    over.access_mode ?? "public",
    JSON.stringify({ modulePrefixes: ["go.acme.dev"] }),
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

/** The host's headers (plans/F-01.md §6.1) and a type on the allowlist that is never text. */
function expectHardened(res: Response, label: string): void {
  expect(res.headers.get("x-content-type-options"), label).toBe("nosniff");
  expect(res.headers.get("content-security-policy"), label).toBe(REGISTRY_CSP);
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
    ecosystem: "go" as const,
    name: MODULE,
    artifacts: { module: { match: "go.mod" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product: OWNER,
      deliverableId: DELIVERABLE,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "go",
      packageName: MODULE,
    },
    NOW,
  );
  await db.run(s.sql, ...s.params);
  await db.run(
    `INSERT INTO dist_access (product, deliverable_id, mode, source, modified_at)
     VALUES (?, ?, 'public', 'manifest', ?)`,
    OWNER,
    DELIVERABLE,
    NOW,
  );
  await setFeed();
  await publish("1.0.0", "stable", NOW + 60);
  await publish("1.0.1", "stable", NOW + 120);
  await publish("1.1.0", "stable", NOW + 180);
  await publish("1.2.0-beta.1", "beta", NOW + 240);
  const y = await yank(
    env,
    db,
    OWNER,
    `${DELIVERABLE}@1.0.1`,
    "broken build",
    ACTOR,
    NOW + 300,
  );
  expect(y.ok).toBe(true);
});

describe("the module proxy's index documents (rendered, golden)", () => {
  it("@v/list names every version but the yanked one, as opaque bytes", async () => {
    const res = await get(`${BASE}/@v/list`);
    expect(res.status).toBe(200);
    expectHardened(res, "list");
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=60, stale-while-revalidate=60",
    );
    const body = await res.text();
    expect(res.headers.get("etag")).toBe(`"${sha256(enc.encode(body))}"`);
    golden("list", body);
    expect(body).toBe("v1.0.0\nv1.1.0\nv1.2.0-beta.1\n");
  });

  it("@latest is the stable head", async () => {
    const res = await get(`${BASE}/@latest`);
    expect(res.status).toBe(200);
    expectHardened(res, "latest");
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.text();
    golden("latest.json", body);
    expect(JSON.parse(body)).toEqual({
      Version: "v1.1.0",
      Time: goTime(NOW + 180),
    });
  });

  it("a version's .info answers for every version, the yanked one included", async () => {
    const res = await get(`${BASE}/@v/v1.0.0.info`);
    expect(res.status).toBe(200);
    golden("v1.0.0.info", await res.text());
    const yanked = await get(`${BASE}/@v/v1.0.1.info`);
    expect(yanked.status).toBe(200);
    expect((await yanked.json()) as unknown).toEqual({
      Version: "v1.0.1",
      Time: goTime(NOW + 120),
    });
  });

  it("a channel name resolves to the canonical version it serves", async () => {
    const res = await get(`${BASE}/@v/beta.info`);
    expect(res.status).toBe(200);
    const body = await res.text();
    golden("beta.info", body);
    expect(JSON.parse(body).Version).toBe("v1.2.0-beta.1");
    expect((await get(`${BASE}/@v/nightly.info`)).status).toBe(404);
  });
});

describe("the .mod and .zip bytes", () => {
  it("are the release's own blobs, immutable, with the digest as ETag", async () => {
    for (const ext of ["mod", "zip"] as const) {
      const res = await get(`${BASE}/@v/v1.1.0.${ext}`);
      expect(res.status, ext).toBe(200);
      expectHardened(res, ext);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes, ext).toEqual(published.get(`1.1.0/${ext}`));
      expect(res.headers.get("etag"), ext).toBe(`"${sha256(bytes)}"`);
      expect(res.headers.get("cache-control"), ext).toContain("immutable");
      expect(res.headers.get("content-disposition"), ext).toContain(
        "attachment",
      );
    }
  });

  it("stay downloadable for a yanked version, so a go.sum that pins it keeps building", async () => {
    const res = await get(`${BASE}/@v/v1.0.1.zip`);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      published.get("1.0.1/zip"),
    );
  });

  it("answer HEAD with the size and Range with 206", async () => {
    const head = await get(`${BASE}/@v/v1.1.0.zip`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(
      String(published.get("1.1.0/zip")!.length),
    );
    const part = await get(`${BASE}/@v/v1.1.0.zip`, {
      headers: { range: "bytes=0-3" },
    });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("modu");
  });

  it("are named by canonical versions only: a channel names no bytes", async () => {
    expect((await get(`${BASE}/@v/beta.zip`)).status).toBe(404);
    expect((await get(`${BASE}/@v/latest.mod`)).status).toBe(404);
    expect((await get(`${BASE}/@v/v9.9.9.zip`)).status).toBe(404);
  });
});

describe("paths, refusals and the ladder", () => {
  it("an unknown module is the 404 the go command falls through on", async () => {
    for (const path of [
      `/go/${OWNER}/go.acme.dev/other/@v/list`,
      // The go command probes a package path's parents as modules.
      `${BASE}/internal/@v/list`,
      `/go/${OWNER}/go.acme.dev/@latest`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toContain("no-store");
    }
  });

  it("matches only the go command's case encoding of the exact module path", async () => {
    // Upper case in a URL is never the go command's: the not-found.
    expect((await get(`/go/${OWNER}/go.acme.dev/Sdk/@v/list`)).status).toBe(
      404,
    );
    // A different case is a different module.
    expect((await get(`/go/${OWNER}/go.acme.dev/sdk/@v/list`)).status).toBe(
      404,
    );
    // A dangling escape is no encoding at all.
    expect((await get(`/go/${OWNER}/go.acme.dev/!/@v/list`)).status).toBe(404);
  });

  it("a feed that is off answers the not-found; a non-public one the Basic challenge", async () => {
    await setFeed({ enabled: 0 });
    expect((await get(`${BASE}/@v/list`)).status).toBe(404);
    await setFeed({ enabled: 1, access_mode: "authenticated" });
    for (const path of [
      `${BASE}/@v/list`,
      `${BASE}/@latest`,
      `${BASE}/@v/v1.1.0.info`,
      `${BASE}/@v/v1.1.0.zip`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toMatch(
        /^Basic realm="/,
      );
      expect(res.headers.get("cache-control"), path).toContain("no-store");
    }
  });

  it("answers a write with the 405", async () => {
    const res = await get(`${BASE}/@v/list`, { method: "PUT" });
    expect(res.status).toBe(405);
  });
});

describe("the renderer and the encoding", () => {
  it("escapes and unescapes as golang.org/x/mod/module does", () => {
    expect(goEscape("github.com/Azure/azure-sdk")).toBe(
      "github.com/!azure/azure-sdk",
    );
    expect(goEscape("v1.0.0-RC1")).toBe("v1.0.0-!r!c1");
    expect(goUnescape("github.com/!azure/azure-sdk")).toBe(
      "github.com/Azure/azure-sdk",
    );
    expect(goUnescape("github.com/Azure")).toBeNull();
    expect(goUnescape("x/!")).toBeNull();
    expect(goUnescape("x/!1")).toBeNull();
  });

  it("omits @latest while the stable channel serves nothing listed, and skips version-like tags", () => {
    const v = (version: string, state: "live" | "yanked" = "live") => ({
      version,
      state,
      stateMessage: null,
      files: [],
      metadata: {},
      publishedAt: NOW,
    });
    const pkg: RegistryPackage = {
      product: OWNER,
      ecosystem: "go",
      deliverableId: DELIVERABLE,
      name: MODULE,
      nameNorm: MODULE.toLowerCase(),
      versions: [v("1.0.0", "yanked"), v("2.0.0-rc.1")],
      tags: { latest: "1.0.0", rc: "2.0.0-rc.1", v2: "2.0.0-rc.1" },
    };
    const keys = renderGo(pkg).map((o) => o.key);
    expect(keys).toEqual([
      "go.acme.dev/%21sdk/@v/list",
      "go.acme.dev/%21sdk/@v/rc.info",
      "go.acme.dev/%21sdk/@v/v1.0.0.info",
      "go.acme.dev/%21sdk/@v/v2.0.0-rc.1.info",
    ]);
  });
});
