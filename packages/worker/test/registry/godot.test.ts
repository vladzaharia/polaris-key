/**
 * The Godot feed (F-09, plans/F-01.md §6.8): both editor API shapes (the ≤ 4.6 Asset Library and
 * the 4.7+ Asset Store), the GodotEnv index and the content-addressed zips and icons, served on
 * the registry host through the real dispatcher, the real `serveFeedRead` ladder and packages
 * published by Release's real package ingest.
 *
 * The fixture is one addon, `acme_addon` (deliverable `godot.addon`), with four versions in
 * publication order: 1.0.0 (stable, later DEPRECATED), 1.0.1 (stable, later YANKED), 1.1.0
 * (stable, with an icon: the `latest` tag) and 1.2.0-beta.1 (the `beta` channel). Every rendered
 * document is pinned by a golden file under `godot/golden/` (`vitest -u` rewrites them).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../src/db/types.js";
import type { Env } from "../../src/env.js";
import { REGISTRY_ROUTES, SERVICES } from "../../src/mount.js";
import {
  REGISTRY_HOST_TYPES,
  dispatchRegistryHost,
} from "../../src/core/registryHost.js";
import { blobKey, recordObject } from "../../src/core/blobs.js";
import {
  stmtUpsertDeliverable,
  stmtYankRelease,
} from "../../src/services/release/model.js";
import { ingestPackageDescriptor } from "../../src/services/release/packages/ingest.js";
import { packageStateStatements } from "../../src/services/release/packages/state.js";
import { forgetRegistrySettings } from "../../src/services/distribution/registry/settings.js";
import {
  RENDER_STAMP_META,
  registryCounters,
  registryObjectKey,
  renderStamp,
} from "../../src/services/distribution/registry/materialise.js";
import {
  assetIdsOf,
  compatible,
  escapeBbcode,
  godotFeedView,
  legacyAssetId,
} from "../../src/services/distribution/registry/godot/documents.js";
import { renderGodot } from "../../src/services/distribution/registry/godot/render.js";
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
const ID = "godot.addon";
const NAME = "acme_addon";
const PUBLISHER = "acme";
const GOLDEN = join(__dirname, "godot", "golden");
const base = `/godot/${SLUG}`;
const LEGACY = `${base}/asset-library/api`;
const STORE = `${base}/store/api/v1`;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

let db: Db;
let env: Env;
let r2: R2Mock;
const files: Record<string, { zip: string; icon?: string }> = {};

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
  meta: Record<string, string>,
  withIcon = false,
): Promise<void> {
  const zipBytes = bytes(`PK fake zip ${NAME} ${version}`);
  const zip = await store(zipBytes);
  const iconBytes = bytes(`\x89PNG fake icon ${version}`);
  const icon = withIcon ? await store(iconBytes) : undefined;
  files[version] = { zip, ...(icon ? { icon } : {}) };
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
        ecosystem: "godot",
        name: NAME,
        files: [
          {
            name: `${NAME}-${version}.zip`,
            role: "payload",
            type: "godot-zip",
            sha256: zip,
            size: zipBytes.length,
            locations: [{ provider: "r2", key: blobKey(zip) }],
          },
          ...(icon
            ? [
                {
                  name: "icon.png",
                  role: "payload",
                  type: "godot-icon",
                  sha256: icon,
                  size: iconBytes.length,
                  locations: [{ provider: "r2", key: blobKey(icon) }],
                },
              ]
            : []),
        ],
        metadata: { name: NAME, version, ...meta },
      },
    },
    {
      now: at,
      promoted: [blobKey(zip), ...(icon ? [blobKey(icon)] : [])],
      feed: {
        ecosystem: "godot",
        enabled: true,
        ownerEnabled: true,
        policyEnabled: true,
        namespace: { publisher: PUBLISHER },
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
  over: {
    enabled?: number;
    access?: string;
    namespace?: object;
    ext?: object;
  } = {},
): Promise<void> {
  await db.run(
    `INSERT INTO dist_registry_feeds (product, ecosystem, enabled, access_mode, namespace_json,
       max_package_bytes, ext_json, updated_at)
     VALUES (?, 'godot', ?, ?, ?, 52428800, ?, ?)
     ON CONFLICT(product, ecosystem) DO UPDATE SET enabled = excluded.enabled,
       access_mode = excluded.access_mode, namespace_json = excluded.namespace_json,
       ext_json = excluded.ext_json`,
    SLUG,
    over.enabled ?? 1,
    over.access ?? "public",
    JSON.stringify(over.namespace ?? { publisher: PUBLISHER }),
    JSON.stringify(
      over.ext ?? { categoryId: "6", license: "MIT", minGodotVersion: "4.4" },
    ),
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

async function getJson(path: string): Promise<unknown> {
  const res = await get(path);
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  return res.json();
}

async function golden(name: string, path: string): Promise<unknown> {
  const doc = await getJson(path);
  await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot(
    join(GOLDEN, `${name}.json`),
  );
  return doc;
}

const ASSET_ID = legacyAssetId(ID);

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
    ecosystem: "godot" as const,
    name: NAME,
    artifacts: { zip: { match: "*.zip" }, icon: { match: "*.png" } },
  };
  const s = stmtUpsertDeliverable(
    {
      product: SLUG,
      deliverableId: ID,
      kind: "package",
      defJson: JSON.stringify(decl),
      ecosystem: "godot",
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
  const meta = {
    displayName: "Acme [Addon] <b>",
    author: "Acme Games",
    description: "Licence checks for Godot.",
  };
  await publish("1.0.0", "stable", NOW - 4000, meta);
  await publish("1.0.1", "stable", NOW - 3000, meta);
  await publish("1.1.0", "stable", NOW - 2000, meta, true);
  await publish("1.2.0-beta.1", "beta", NOW - 1000, meta);
  await setState("1.0.0", "deprecate", "use 1.1.0");
  await setState("1.0.1", "yank", "broken export");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Godot ≤ 4.6: the Asset Library API", () => {
  it("configure lists the addon categories, or the project ones", async () => {
    await golden("legacy-configure", `${LEGACY}/configure`);
    await golden(
      "legacy-configure-project",
      `${LEGACY}/configure?type=project`,
    );
  });

  it("asset?… lists the addon at its latest version, as the 4.6 editor asks", async () => {
    const doc = (await golden(
      "legacy-search",
      `${LEGACY}/asset?sort=updated&godot_version=4.6&support=official+community+testing&page=0`,
    )) as { result: Array<Record<string, string>>; total: number };
    expect(doc.total).toBe(1);
    expect(doc.result[0]!.asset_id).toBe(ASSET_ID);
    expect(doc.result[0]!.version_string).toBe("1.1.0");
  });

  it("asset?… filters in memory: text, category, support, version, type and paging", async () => {
    const count = async (q: string) =>
      ((await getJson(`${LEGACY}/asset?${q}`)) as { result: unknown[] }).result
        .length;
    expect(await count("filter=licence")).toBe(1);
    expect(await count("filter=%20LICENCE%20")).toBe(1);
    expect(await count("filter=nothing-like-it")).toBe(0);
    expect(await count("category=6")).toBe(1);
    expect(await count("category=1")).toBe(0);
    expect(await count("support=testing")).toBe(0);
    expect(await count("support=featured+community")).toBe(1);
    expect(await count("godot_version=4.3")).toBe(0);
    expect(await count("godot_version=4.4")).toBe(1);
    expect(await count("godot_version=3.5")).toBe(0);
    expect(await count("type=project")).toBe(0);
    expect(await count("type=any")).toBe(1);
    expect(await count("user=acme")).toBe(1);
    expect(await count("cost=GPLv3")).toBe(0);
    expect(await count("page=1")).toBe(0);
    expect(await count("max_results=1&offset=0")).toBe(1);
  });

  it("asset/<id> carries download_url, the zip's SHA-256 as download_hash and provider Custom", async () => {
    const doc = (await golden(
      "legacy-asset",
      `${LEGACY}/asset/${ASSET_ID}`,
    )) as Record<string, string>;
    expect(doc.download_hash).toBe(files["1.1.0"]!.zip);
    expect(doc.download_provider).toBe("Custom");
    expect(doc.download_url).toBe(
      `${PKG}${base}/files/${files["1.1.0"]!.zip}/${NAME}-1.1.0.zip`,
    );
    expect(doc.icon_url).toBe(
      `${PKG}${base}/icons/${files["1.1.0"]!.icon}.png`,
    );
    // The bytes behind download_url hash to download_hash, which is what the editor compares.
    const zip = await get(new URL(doc.download_url!).pathname);
    expect(zip.status).toBe(200);
    expect(sha(new Uint8Array(await zip.arrayBuffer()))).toBe(
      doc.download_hash,
    );
  });

  it("an unknown asset id is the not-found", async () => {
    const res = await get(`${LEGACY}/asset/12345`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("Godot 4.7+: the Asset Store API", () => {
  it("the root, tags and licenses answer what the 4.7 editor reads first", async () => {
    await golden("store-overview", `${STORE}/`);
    expect(await getJson(`${STORE}/tags/?featured_only=true`)).toEqual([]);
    await golden("store-licenses", `${STORE}/licenses/`);
  });

  it("search/query/ returns hits in the store's shape", async () => {
    const doc = (await golden(
      "store-search",
      `${STORE}/search/query/?query=&require_release=true&type=0&sort=relevance&compatibility=4.7`,
    )) as { count: string };
    expect(doc.count).toBe("1");
  });

  it("search/query/ filters in memory", async () => {
    const count = async (q: string) =>
      ((await getJson(`${STORE}/search/query/?${q}`)) as { count: string })
        .count;
    expect(await count("query=acme")).toBe("1");
    expect(await count("query=acme%20licence")).toBe("1");
    expect(await count("query=%23audio")).toBe("0");
    expect(await count("query=zzz")).toBe("0");
    expect(await count("query=&type=1")).toBe("0");
    expect(await count("query=&featured_only=true")).toBe("0");
    expect(await count("query=&licenses=MIT")).toBe("1");
    expect(await count("query=&licenses=GPL%20v3")).toBe("0");
    expect(await count("query=&licenses=GPL&licenses=MIT")).toBe("1");
    expect(await count("query=&compatibility=4.3")).toBe("0");
    expect(await count("query=&stable_only=true")).toBe("1");
  });

  it("assets/<publisher>/<asset>/ is the detail, with escaped BBCode and HTML", async () => {
    const doc = (await golden(
      "store-asset",
      `${STORE}/assets/${PUBLISHER}/${NAME}/`,
    )) as Record<string, unknown>;
    expect(doc.name).toBe("Acme [Addon] <b>");
    expect(doc.body_bbcode).toBe("Licence checks for Godot.");
    // A wrong publisher is absent.
    expect((await get(`${STORE}/assets/other/${NAME}/`)).status).toBe(404);
    expect((await get(`${STORE}/assets/${PUBLISHER}/nope/`)).status).toBe(404);
  });

  it("releases/… lists the listed versions newest first, without the yanked one", async () => {
    const all = (await golden(
      "store-releases",
      `${STORE}/releases/${PUBLISHER}/${NAME}/`,
    )) as Array<Record<string, unknown>>;
    expect(all.map((r) => r.version)).toEqual([
      "1.2.0-beta.1",
      "1.1.0",
      "1.0.0",
    ]);
    expect(all.map((r) => r.stable)).toEqual([false, true, true]);
    expect(all[2]!.notes).toBe("Deprecated: use 1.1.0");
    const stable = (await getJson(
      `${STORE}/releases/${PUBLISHER}/${NAME}/?stable_only=true`,
    )) as Array<Record<string, unknown>>;
    expect(stable.map((r) => r.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(
      await getJson(
        `${STORE}/releases/${PUBLISHER}/${NAME}/?compatibility=4.2`,
      ),
    ).toEqual([]);
  });

  it("the store paths answer without their trailing slash too", async () => {
    expect((await get(`${STORE}`)).status).toBe(200);
    expect((await get(`${STORE}/assets/${PUBLISHER}/${NAME}`)).status).toBe(
      200,
    );
  });
});

describe("GodotEnv: index.json", () => {
  it("lists every listed version with its zip URL, SHA-256 and an addons.json entry", async () => {
    const doc = (await golden("index", `${base}/index.json`)) as {
      packages: Array<{
        latest: string;
        tags: Record<string, string>;
        versions: Array<{ version: string; deprecated?: string }>;
        godotenv: Record<string, { source: string; subfolder: string }>;
      }>;
    };
    const p = doc.packages[0]!;
    expect(p.latest).toBe("1.1.0");
    expect(p.tags).toEqual({ beta: "1.2.0-beta.1", latest: "1.1.0" });
    expect(p.versions.map((v) => v.version)).toEqual([
      "1.2.0-beta.1",
      "1.1.0",
      "1.0.0",
    ]);
    expect(p.versions[2]!.deprecated).toBe("use 1.1.0");
    expect(p.godotenv[NAME]).toMatchObject({
      source: "zip",
      subfolder: `addons/${NAME}`,
    });
  });
});

describe("bytes: zips and icons under content-addressed paths", () => {
  it("serves the zip as an immutable application/zip attachment with a SHA-256 ETag", async () => {
    const h = files["1.1.0"]!.zip;
    const res = await get(`${base}/files/${h}/${NAME}-1.1.0.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("cache-control")).toMatch(
      /^public, max-age=31536000, immutable/,
    );
    expect(res.headers.get("etag")).toBe(`"${h}"`);
    const range = await get(`${base}/files/${h}/${NAME}-1.1.0.zip`, {
      headers: { range: "bytes=0-1" },
    });
    expect(range.status).toBe(206);
    const notModified = await get(`${base}/files/${h}/${NAME}-1.1.0.zip`, {
      headers: { "if-none-match": `"${h}"` },
    });
    expect(notModified.status).toBe(304);
  });

  it("serves the icon as image/png", async () => {
    const res = await get(`${base}/icons/${files["1.1.0"]!.icon}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("a yanked version's bytes stay fetchable (immutable), but it is in no listing", async () => {
    const h = files["1.0.1"]!.zip;
    expect((await get(`${base}/files/${h}/${NAME}-1.0.1.zip`)).status).toBe(
      200,
    );
    const index = JSON.stringify(await getJson(`${base}/index.json`));
    expect(index).not.toContain("1.0.1");
  });

  it("a wrong name, another hash or a bare blob is the not-found", async () => {
    const h = files["1.1.0"]!.zip;
    expect((await get(`${base}/files/${h}/other.zip`)).status).toBe(404);
    expect(
      (await get(`${base}/files/${"a".repeat(64)}/${NAME}-1.1.0.zip`)).status,
    ).toBe(404);
    expect((await get(`${base}/icons/${h}.png`)).status).toBe(404);
  });
});

describe("the headers of §6.7 and the host's rules", () => {
  const paths = () => [
    `${LEGACY}/configure`,
    `${LEGACY}/asset`,
    `${LEGACY}/asset/${ASSET_ID}`,
    `${STORE}/`,
    `${STORE}/tags/`,
    `${STORE}/licenses/`,
    `${STORE}/search/query/?query=`,
    `${STORE}/assets/${PUBLISHER}/${NAME}/`,
    `${STORE}/releases/${PUBLISHER}/${NAME}/`,
    `${base}/index.json`,
  ];

  it("every index document is public for 60 s with a strong ETag of its body, and 304s", async () => {
    for (const path of paths()) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe(
        "public, max-age=60, stale-while-revalidate=60",
      );
      const body = new Uint8Array(await res.arrayBuffer());
      expect(res.headers.get("etag"), path).toBe(`"${sha(body)}"`);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), path).toMatch(
        /^sandbox/,
      );
      expect(
        REGISTRY_HOST_TYPES.has(res.headers.get("content-type")!),
        path,
      ).toBe(true);
      const again = await get(path, {
        headers: { "if-none-match": res.headers.get("etag")! },
      });
      expect(again.status, path).toBe(304);
      const head = await get(path, { method: "HEAD" });
      expect(head.status, path).toBe(200);
      expect(await head.text(), path).toBe("");
    }
  });

  it("a disabled feed, packageFeeds off or the kill switch answers the same not-found", async () => {
    await setFeed({ enabled: 0 });
    for (const path of paths()) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
    await setFeed();
    await db.run("UPDATE dist_registry_owners SET enabled = 0");
    forgetRegistrySettings();
    expect((await get(`${base}/index.json`)).status).toBe(404);
    await db.run("UPDATE dist_registry_owners SET enabled = 1");
    await db.run(
      "UPDATE dist_registry_policy SET enabled = 0 WHERE ecosystem = 'godot'",
    );
    forgetRegistrySettings();
    expect((await get(`${LEGACY}/asset/${ASSET_ID}`)).status).toBe(404);
  });

  it("a non-public feed answers 401 with HTTP Basic, private and uncached", async () => {
    await setFeed({ access: "licensed" });
    for (const path of paths()) {
      const res = await get(path);
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toMatch(
        /^Basic realm=/,
      );
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("a package stricter than the feed is left out of every list and refused by id", async () => {
    await db.run(
      "INSERT INTO dist_access (product, deliverable_id, mode, modified_at) VALUES (?, ?, 'licensed', ?)",
      SLUG,
      ID,
      NOW,
    );
    forgetRegistrySettings();
    const search = (await getJson(`${LEGACY}/asset`)) as { result: unknown[] };
    expect(search.result).toEqual([]);
    expect(
      ((await getJson(`${base}/index.json`)) as { packages: unknown[] })
        .packages,
    ).toEqual([]);
    expect((await get(`${LEGACY}/asset/${ASSET_ID}`)).status).toBe(401);
    expect(
      (await get(`${base}/files/${files["1.1.0"]!.zip}/${NAME}-1.1.0.zip`))
        .status,
    ).toBe(401);
  });

  it("a feed without a publisher serves nothing", async () => {
    await setFeed({ namespace: {} });
    expect((await get(`${base}/index.json`)).status).toBe(404);
    expect((await get(`${LEGACY}/asset/${ASSET_ID}`)).status).toBe(404);
  });

  it("only GET and HEAD", async () => {
    expect((await get(`${base}/index.json`, { method: "POST" })).status).toBe(
      405,
    );
  });
});

describe("render-on-write, kept fresh", () => {
  it("the per-package documents are rendered into R2 with the render stamp", async () => {
    await getJson(`${LEGACY}/asset/${ASSET_ID}`);
    const obj = await r2.head(
      registryObjectKey("godot", SLUG, `asset-library/api/asset/${ASSET_ID}`),
    );
    expect(obj?.customMetadata?.[RENDER_STAMP_META]).toMatch(/^[0-9a-f]{32}$/);
    expect(registryCounters.renderMiss).toBe(1);
    await getJson(`${STORE}/assets/${PUBLISHER}/${NAME}/`);
    // The same render wrote every document of the package.
    expect(registryCounters.renderMiss).toBe(1);
  });

  it("a yank after the render is never hidden by the stored document", async () => {
    const before = (await getJson(`${LEGACY}/asset/${ASSET_ID}`)) as Record<
      string,
      string
    >;
    expect(before.version_string).toBe("1.1.0");
    await setState("1.1.0", "yank", "regression");
    const after = (await getJson(`${LEGACY}/asset/${ASSET_ID}`)) as Record<
      string,
      string
    >;
    // The `latest` tag (the stable channel's head) moves back to 1.0.0: still listed, though
    // deprecated, so the description leads with the deprecation.
    expect(after.version_string).toBe("1.0.0");
    expect(after.download_hash).toBe(files["1.0.0"]!.zip);
    expect(after.description).toMatch(/^Deprecated: use 1\.1\.0/);
  });

  it("a settings change re-renders the stored documents", async () => {
    const before = (await getJson(`${LEGACY}/asset/${ASSET_ID}`)) as Record<
      string,
      string
    >;
    expect(before.category_id).toBe("6");
    await setFeed({ ext: { categoryId: "5", license: "MIT" } });
    const after = (await getJson(`${LEGACY}/asset/${ASSET_ID}`)) as Record<
      string,
      string
    >;
    expect(after.category_id).toBe("5");
  });

  it("every version yanked: the package leaves the lists and its documents are absent", async () => {
    for (const v of ["1.0.0", "1.1.0", "1.2.0-beta.1"])
      await setState(v, "yank", "gone");
    expect((await get(`${LEGACY}/asset/${ASSET_ID}`)).status).toBe(404);
    expect((await get(`${STORE}/releases/${PUBLISHER}/${NAME}/`)).status).toBe(
      404,
    );
    expect(
      ((await getJson(`${STORE}/search/query/?query=`)) as { count: string })
        .count,
    ).toBe("0");
  });
});

describe("documents (pure)", () => {
  it("legacy ids fit the editor's 32-bit int and collisions are dropped", () => {
    const id = Number(legacyAssetId("godot.addon"));
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(2 ** 31);
    expect(legacyAssetId("godot.addon")).toBe(legacyAssetId("godot.addon"));
    const ids = assetIdsOf(["a", "b"]);
    expect(ids.size).toBe(2);
  });

  it("escapes BBCode brackets", () => {
    expect(escapeBbcode("[url=x]y[/url]")).toBe("[lb]url=x[rb]y[lb]/url[rb]");
  });

  it("compatibility: same major, at or above the minimum", () => {
    const view = godotFeedView(SLUG, PKG, {
      namespace: { publisher: "acme" },
      ext: { minGodotVersion: "4.4.1" },
    })!;
    expect(compatible(view, "4.4")).toBe(false);
    expect(compatible(view, "4.4.1")).toBe(true);
    expect(compatible(view, "4.7")).toBe(true);
    expect(compatible(view, "5.0")).toBe(false);
    expect(compatible(view, null)).toBe(true);
  });

  it("the render stamp covers the feed settings only when a render was given them", async () => {
    const pkg = {
      product: SLUG,
      ecosystem: "godot" as const,
      deliverableId: ID,
      name: NAME,
      nameNorm: NAME,
      versions: [],
      tags: {},
    };
    const feed = { namespace: { publisher: "acme" }, ext: {} };
    expect(await renderStamp(pkg, undefined)).toBe(await renderStamp(pkg));
    expect(await renderStamp(pkg, feed)).not.toBe(await renderStamp(pkg));
    expect(await renderStamp(pkg, feed)).not.toBe(
      await renderStamp(pkg, { ...feed, ext: { categoryId: "6" } }),
    );
  });

  it("renders nothing without feed settings", () => {
    expect(
      renderGodot(
        {
          product: SLUG,
          ecosystem: "godot",
          deliverableId: ID,
          name: NAME,
          nameNorm: NAME,
          versions: [],
          tags: {},
        },
        { origin: PKG },
      ),
    ).toEqual([]);
  });

  it("falls back to the defaults for malformed extensions", () => {
    const view = godotFeedView(SLUG, PKG, {
      namespace: { publisher: "acme" },
      ext: { categoryId: "9", supportLevel: "gold", license: "" },
    })!;
    expect(view).toMatchObject({
      categoryId: "5",
      supportLevel: "community",
      license: "Unspecified",
      minGodotVersion: null,
    });
    expect(
      godotFeedView(SLUG, PKG, {
        namespace: { publisher: "Bad Name" },
        ext: {},
      }),
    ).toBeNull();
  });
});
