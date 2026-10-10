/**
 * The Cargo feed (F-30, plans/F-01.md §6.8): the sparse index (`config.json`, the index files
 * under Cargo's prefixes) and the content-addressed crate downloads, served on the registry host
 * through the real dispatcher, the real `serveFeedRead` ladder and crates published by Release's
 * real package ingest.
 *
 * The fixture is one crate, `Acme-SDK` (deliverable `cargo.sdk`), with three versions in
 * publication order: 0.9.0 (stable, later YANKED), 1.0.0 (stable, later DEPRECATED, which Cargo
 * has no word for, with every dependency shape the index carries) and 1.1.0-beta.1 (the `beta`
 * channel, a semver pre-release). Every rendered document is pinned by a golden file under
 * `cargo/golden/` (`vitest -u` rewrites them).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/platform/env.js";
import { REGISTRY_ROUTES, SERVICES } from "../../src/mount.js";
import { dispatchRegistryHost } from "../../src/core/registry/registryHost.js";
import { blobKey, recordObject } from "../../src/core/assets/blobs.js";
import {
  stmtUpsertDeliverable,
  stmtYankRelease,
} from "../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../../src/services/release/packages/state.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  forgetRegistryTokens,
  mintRegistryToken,
} from "../../src/core/registry/registryTokens.js";
import { registryCounters } from "../../src/services/distribution/registry/materialise.js";
import {
  CRATES_IO_INDEX,
  configJson,
  indexPath,
  renderCargo,
} from "../../src/services/distribution/registry/cargo/render.js";
import { makeTestDb } from "../helpers.js";
import { KvMock } from "../kvMock.js";
import { R2Mock, asR2 } from "../r2Mock.js";
import { NOW } from "../seed.js";
import {
  BYTES,
  SLUG,
  envFor,
  seedReleaseProduct,
} from "../releaseRoutesFixture.js";

const PKG = "https://pkg.example.test";
const ID = "cargo.sdk";
const NAME = "Acme-SDK";
const GOLDEN = join(__dirname, "cargo", "golden");
const base = `/cargo/${SLUG}`;
const INDEX = `${base}/ac/me/acme-sdk`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

let db: Db;
let env: Env;
let r2: R2Mock;
const crates: Record<string, string> = {};

/** 1.0.0's dependencies, as the CLI's extractor writes them from a normalised Cargo.toml. */
const DEPS_1_0 = [
  // crates.io: no registry-index in the manifest.
  {
    name: "serde",
    req: "^1.0",
    features: ["derive"],
    optional: false,
    default_features: true,
    target: null,
    kind: "normal",
    registry: null,
  },
  // A sibling crate on this feed: `cargo package` wrote this feed's index URL.
  {
    name: "acme-core",
    req: "^0.3",
    features: [],
    optional: false,
    default_features: true,
    target: null,
    kind: "normal",
    registry: `sparse+${PKG}/cargo/${SLUG}/`,
  },
  // Renamed, optional, without default features, on one target.
  {
    name: "json",
    req: "^1",
    features: [],
    optional: true,
    default_features: false,
    target: "cfg(unix)",
    kind: "normal",
    registry: null,
    package: "serde_json",
  },
  // Another alternative registry.
  {
    name: "other",
    req: "=2.0.0",
    features: [],
    optional: false,
    default_features: true,
    target: null,
    kind: "build",
    registry: "sparse+https://other.example/index/",
  },
  { name: "proptest", req: "^1", kind: "dev", registry: null },
  // Malformed entries are dropped, never rendered.
  { name: "1bad", req: "^1" },
  { name: "ok-name", req: "^1", kind: "peer" },
  "not-an-object",
];

async function store(data: Uint8Array): Promise<string> {
  const digest = sha(data);
  await r2.put(blobKey(digest), data, { sha256: digest });
  await recordObject(
    db,
    {
      storageKey: blobKey(digest),
      sha256: digest,
      size: data.length,
      kind: "blob",
      gated: false,
    },
    NOW,
  );
  return digest;
}

async function publish(
  version: string,
  channel: string,
  at: number,
  meta: Record<string, unknown>,
): Promise<void> {
  const crateBytes = bytes(`fake crate ${NAME} ${version}`);
  const crate = await store(crateBytes);
  crates[version] = crate;
  const res = await ingestPackageDescriptor(
    db,
    env,
    SLUG,
    {
      descriptorVersion: 1,
      product: SLUG,
      deliverable: ID,
      kind: "package",
      version,
      channel,
      package: {
        ecosystem: "cargo",
        name: NAME,
        files: [
          {
            name: `${NAME}-${version}.crate`,
            role: "payload",
            type: "crate",
            sha256: crate,
            size: crateBytes.length,
            locations: [{ provider: "r2", key: blobKey(crate) }],
          },
        ],
        metadata: { name: NAME, version, ...meta },
      },
    },
    {
      now: at,
      promoted: [blobKey(crate)],
      feed: {
        ecosystem: "cargo",
        enabled: true,
        ownerEnabled: true,
        policyEnabled: true,
        namespace: {},
        maxPackageBytes: 52428800,
        ext: {},
      },
      source: { kind: "static" },
      digests: async () => new Map(),
    },
  );
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

async function setState(
  version: string,
  op: "yank" | "deprecate",
  message: string,
): Promise<void> {
  const releaseId = `${ID}@${version}`;
  const stmts = await packageStateStatements(
    db,
    SLUG,
    releaseId,
    op,
    message,
    NOW + 100,
  );
  if (op === "yank")
    stmts.unshift(stmtYankRelease(SLUG, releaseId, message, "test", NOW + 100));
  await db.batch(stmts);
}

async function setFeed(
  over: { enabled?: number; access?: string } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, 'cargo', ?, ?, '{}', 52428800, '{}', ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET enabled = excluded.enabled,
       access_mode = excluded.access_mode`,
    SLUG,
    over.enabled ?? 1,
    over.access ?? "public",
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

async function golden(name: string, path: string): Promise<string> {
  const res = await get(path);
  const body = await res.text();
  expect(res.status, `${path}: ${body}`).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  await expect(body).toMatchFileSnapshot(join(GOLDEN, name));
  return body;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  db = makeTestDb();
  env = envFor({ kv: new KvMock(), blobOrigin: BYTES });
  env.PKG_ORIGIN = PKG;
  r2 = new R2Mock();
  env.BLOBS = asR2(r2);
  forgetRegistrySettings();
  registryCounters.renderMiss = 0;
  await seedReleaseProduct(db);
  const decl = {
    kind: "package" as const,
    id: ID,
    ecosystem: "cargo" as const,
    name: NAME,
    artifacts: { crate: { match: "*.crate" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product: SLUG,
      deliverableId: ID,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "cargo",
      packageName: NAME,
    },
    NOW,
  );
  await db.run(s.sql, ...s.params);
  await db.run(
    "INSERT INTO dist_registry_owners (product, enabled, updated_at) VALUES (?, 1, ?)",
    SLUG,
    NOW,
  );
  await setFeed();
  await publish("0.9.0", "stable", NOW - 3000, {
    description: "Licence checks for Rust.",
    license: "MIT",
    deps: [],
    features: {},
  });
  await publish("1.0.0", "stable", NOW - 2000, {
    description: "Licence checks for Rust.",
    license: "MIT",
    rustVersion: "1.74",
    links: "acme",
    deps: DEPS_1_0,
    features: {
      default: ["std"],
      std: [],
      serde: ["dep:serde", "acme-core?/serde"],
      "bad name!": ["x"],
    },
  });
  await publish("1.1.0-beta.1", "beta", NOW - 1000, {
    deps: [],
    features: {},
  });
  await setState("0.9.0", "yank", "broken build");
  await setState("1.0.0", "deprecate", "use 1.1");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("config.json", () => {
  it("names the content-addressed dl template and no publish api on a public feed", async () => {
    const body = await golden("config.json", `${base}/config.json`);
    const doc = JSON.parse(body) as Record<string, unknown>;
    expect(doc.dl).toBe(
      `${PKG}/cargo/${SLUG}/files/{sha256-checksum}/{crate}-{version}.crate`,
    );
    expect(doc).not.toHaveProperty("api");
    expect(doc).not.toHaveProperty("auth-required");
    const res = await get(`${base}/config.json`);
    expect(res.headers.get("cache-control")).toMatch(/^public, max-age=60/);
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
  });
});

describe("index files", () => {
  it("one JSON line per version, oldest first: yank, pre-release, deps and features as Cargo reads them", async () => {
    const body = await golden("acme-sdk.jsonl", INDEX);
    const lines = body
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.vers)).toEqual([
      "0.9.0",
      "1.0.0",
      "1.1.0-beta.1",
    ]);
    expect(body.endsWith("\n")).toBe(true);
    // Cargo's yank: the line stays, marked.
    expect(lines.map((l) => l.yanked)).toEqual([true, false, false]);
    // The declared name, the crate's checksum.
    expect(lines[1]!.name).toBe(NAME);
    expect(lines[1]!.cksum).toBe(crates["1.0.0"]);
    // Deprecation has no Cargo equivalent: nothing in the line says so.
    expect(JSON.stringify(lines[1])).not.toContain("use 1.1");
    const deps = lines[1]!.deps as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(deps.map((d) => [d.name, d]));
    expect(Object.keys(byName).sort()).toEqual(
      ["acme-core", "json", "other", "proptest", "serde"].sort(),
    );
    expect(byName.serde!.registry).toBe(CRATES_IO_INDEX);
    expect(byName["acme-core"]!.registry).toBeNull();
    expect(byName.other!.registry).toBe("sparse+https://other.example/index/");
    expect(byName.json).toMatchObject({
      package: "serde_json",
      optional: true,
      default_features: false,
      target: "cfg(unix)",
    });
    expect(byName.proptest).toMatchObject({ kind: "dev", req: "^1" });
    // The v2 split: `dep:` and `?/` features only in features2.
    expect(lines[1]!.features).toEqual({ default: ["std"], std: [] });
    expect(lines[1]!.features2).toEqual({
      serde: ["dep:serde", "acme-core?/serde"],
    });
    expect(lines[1]!.v).toBe(2);
    expect(lines[1]!.rust_version).toBe("1.74");
    expect(lines[1]!.links).toBe("acme");
    expect(lines[0]).not.toHaveProperty("v");
  });

  it("answers only the lower-case name under its own prefix", async () => {
    expect((await get(INDEX)).status).toBe(200);
    for (const path of [
      `${base}/AC/ME/Acme-SDK`,
      `${base}/ac/me/Acme-SDK`,
      `${base}/ac/mx/acme-sdk`,
      `${base}/3/a/acme-sdk`,
      `${base}/ac/me/acme-sdx`,
      `${base}/ac/me/acme_sdk`,
    ])
      expect((await get(path)).status, path).toBe(404);
  });

  it("Cargo's prefix scheme by name length", () => {
    expect(indexPath("a")).toBe("1/a");
    expect(indexPath("ab")).toBe("2/ab");
    expect(indexPath("abc")).toBe("3/a/abc");
    expect(indexPath("Cargo")).toBe("ca/rg/cargo");
  });

  it("an unknown owner, a feed that is off and an unknown crate answer the same not-found", async () => {
    const unknown = await get(`${base}/ab/cd/abcdef`);
    expect(unknown.status).toBe(404);
    const want = await unknown.text();
    expect(await (await get(`/cargo/nobody/ac/me/acme-sdk`)).text()).toBe(want);
    await setFeed({ enabled: 0 });
    for (const path of [INDEX, `${base}/config.json`])
      expect(await (await get(path)).text(), path).toBe(want);
  });

  it("a pure render: the crate's one index file, nothing before a crate is published", () => {
    const pkg = {
      product: SLUG,
      ecosystem: "cargo" as const,
      deliverableId: ID,
      name: "x",
      nameNorm: "x",
      versions: [
        {
          version: "1.0.0",
          state: "live" as const,
          stateMessage: null,
          files: [],
          metadata: {},
          publishedAt: NOW,
        },
      ],
      tags: {},
    };
    expect(renderCargo(pkg, { origin: PKG })).toEqual([]);
  });
});

describe("crate downloads (dl)", () => {
  it("serves a version's crate by checksum, crate name and version, immutably", async () => {
    const res = await get(
      `${base}/files/${crates["1.0.0"]}/${NAME}-1.0.0.crate`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`fake crate ${NAME} 1.0.0`);
    expect(res.headers.get("cache-control")).toContain("immutable");
    // The yanked version stays downloadable for the lockfiles that pin it.
    expect(
      (await get(`${base}/files/${crates["0.9.0"]}/${NAME}-0.9.0.crate`))
        .status,
    ).toBe(200);
  });

  it("refuses a checksum, name or version that do not belong together", async () => {
    for (const path of [
      `${base}/files/${crates["1.0.0"]}/${NAME}-0.9.0.crate`,
      `${base}/files/${crates["1.0.0"]}/acme-sdk-1.0.0.crate`,
      `${base}/files/${"0".repeat(64)}/${NAME}-1.0.0.crate`,
      `${base}/files/${crates["1.0.0"]}/${NAME}-1.0.0.zip`,
    ])
      expect((await get(path)).status, path).toBe(404);
  });
});

describe("authenticated feeds (F-21)", () => {
  beforeEach(() => {
    forgetRegistryTokens();
  });

  async function token(): Promise<string> {
    const res = await mintRegistryToken(
      env,
      db,
      {
        product: SLUG,
        label: "cargo",
        binding: "owner",
        presentation: "header",
        createdBy: "admin:test",
      },
      NOW,
    );
    if (!res.ok) throw new Error(JSON.stringify(res));
    return res.token;
  }

  it("401 without a token; Cargo's bare Authorization admits, and config.json says auth-required", async () => {
    await setFeed({ access: "authenticated" });
    for (const path of [`${base}/config.json`, INDEX]) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm=/);
    }
    const t = await token();
    const headers = { authorization: t };
    const config = await get(`${base}/config.json`, { headers });
    expect(config.status).toBe(200);
    expect(config.headers.get("cache-control")).toBe("private, no-store");
    expect(await config.json()).toEqual(
      JSON.parse(configJson(PKG, SLUG, true)),
    );
    expect(JSON.parse(configJson(PKG, SLUG, true))["auth-required"]).toBe(true);
    const index = await get(INDEX, { headers });
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("private, no-store");
    const dl = await get(
      `${base}/files/${crates["1.0.0"]}/${NAME}-1.0.0.crate`,
      { headers },
    );
    expect(dl.status).toBe(200);
  });
});
