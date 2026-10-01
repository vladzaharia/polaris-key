/**
 * P2-04 — the declared artifact map and release descriptor ingest.
 *
 *   1. Map classification: a Diceroll-shaped GitHub release is classified by `.pkey/release`'s
 *      `deliverables.app.artifacts` into six builds; without a map it is sniffed as before.
 *   2. CI ingest (`ingestReleaseDescriptor`): every cross-check refuses, and a refusal writes
 *      nothing; the same descriptor twice is a no-op; `dryRun` plans and writes nothing; `r2`
 *      locations earn a blob ref only when promoted or already referenced.
 *   3. The GitHub path: the sync ingests `pkey-release.json`, refuses a mutable release into
 *      `release_health`, and does not re-fetch a descriptor it has decided on.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseManifest,
  type ManifestAppDeliverable,
} from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import type { Db, DbStatement } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { syncReleaseStore } from "../src/services/release/sync.js";
import {
  ingestReleaseDescriptor,
  MAX_DESCRIPTOR_FETCHES_PER_SYNC,
} from "../src/services/release/descriptor.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import {
  getChannelPolicy,
  getDeliverable,
  listBuilds,
} from "../src/services/release/model.js";
import {
  listReleaseArtifacts,
  listReleaseHealth,
  listReleaseMetadata,
  releaseStoreStatements,
} from "../src/services/release/store.js";
import { recordRef } from "../src/core/blobs.js";

const SLUG = "diceroll";
const OWNER = "vladzaharia";
const REPO = "diceroll";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── The manifest ─────────────────────────────────────────────────────────────

/** README §3.12's artifact map (`portable` dropped: installer versus portable is the format). */
const ARTIFACTS = [
  ["macos", "macos", "universal", "dmg", "Diceroll-*-macos.dmg"],
  ["win-zip", "windows", "x86_64", "zip", "Diceroll-*-windows-x86_64.zip"],
  ["linux-x64", "linux", "x86_64", "tar.gz", "Diceroll-*-linux-x86_64.tar.gz"],
  ["apk", "android", "any", "apk", "Diceroll-*-android.apk"],
  ["ipa-sideload", "ios", "arm64", "ipa", "Diceroll-*-ios-sideload.ipa"],
  ["web", "web", "wasm32", "zip", "Diceroll-*-web.zip"],
].map(([id, platform, arch, format, match]) => ({
  id: id!,
  platform: platform!,
  arch: arch!,
  format: format!,
  match: match!,
}));

function releaseDoc(withMap: boolean): Record<string, unknown> {
  return {
    release: {
      provider: { type: "github", owner: OWNER, repo: REPO },
      binaryName: "diceroll",
      ...(withMap
        ? {
            deliverables: {
              app: {
                kind: "app",
                versioning: {
                  scheme: "semver",
                  stableTagPattern: "v\\d+\\.\\d+\\.\\d+",
                  ignoreTags: ["channels", "packs"],
                  buildNumber: "descriptor",
                },
                channels: { beta: { includes: ["stable"] } },
                artifacts: ARTIFACTS,
              },
            },
          }
        : {}),
    },
  };
}

const PRODUCT_DOC = {
  slug: SLUG,
  name: "Diceroll",
  modules: {
    license: { enabled: true },
    release: { enabled: true },
    update: { enabled: true },
  },
};

function manifestFiles(withMap: boolean): Record<string, string> {
  return {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": JSON.stringify(PRODUCT_DOC),
    ".pkey/release.json": JSON.stringify(releaseDoc(withMap)),
  };
}

/** The declaration as the validator normalises it (what resync persists as `def_json`). */
function appDeclaration(): ManifestAppDeliverable {
  const res = parseManifest({
    product: JSON.stringify(PRODUCT_DOC),
    schema: JSON.stringify({ schemaVersion: 1, entries: [] }),
    release: JSON.stringify(releaseDoc(true)),
  });
  if (!res.ok) throw new Error(res.errors.join("\n"));
  return res.manifest.release!.app!;
}

// ── GitHub fixtures ──────────────────────────────────────────────────────────

const FILES = [
  "Diceroll-1.2.3-macos.dmg",
  "Diceroll-1.2.3-macos.dmg.sig",
  "Diceroll-1.2.3-windows-x86_64.zip",
  "Diceroll-1.2.3-linux-x86_64.tar.gz",
  "Diceroll-1.2.3-android.apk",
  "Diceroll-1.2.3-ios-sideload.ipa",
  "Diceroll-1.2.3-web.zip",
];

function asset(name: string, id: number, tag = "v1.2.3"): ReleaseAsset {
  return {
    id,
    name,
    size: 1000 + id,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${name}`,
    digest: `sha256:${sha(name)}`,
  };
}

function ghRelease(over: Partial<Release> = {}): Release {
  return {
    tag_name: "v1.2.3",
    name: "Diceroll 1.2.3",
    body: "notes",
    published_at: "2026-09-01T00:00:00Z",
    html_url: `https://github.com/${OWNER}/${REPO}/releases/tag/v1.2.3`,
    prerelease: false,
    draft: false,
    immutable: true,
    assets: FILES.map((n, i) => asset(n, 101 + i)),
    ...over,
  };
}

/** A GitHub stub: App installation + token, the manifest, the release list, tag lookups and
 *  release-asset downloads (counted). */
function github(
  releases: Release[],
  opts: { withMap?: boolean; assets?: Record<number, string> } = {},
): { fetchImpl: FetchImpl; assetFetches: () => number } {
  let assetFetches = 0;
  const files = manifestFiles(opts.withMap ?? true);
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    if (url.endsWith("/installation"))
      return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/releases?per_page"))
      return new Response(JSON.stringify(releases), { status: 200 });
    const tag = /\/releases\/tags\/([^/?]+)$/.exec(url);
    if (tag) {
      const r = releases.find(
        (x) => x.tag_name === decodeURIComponent(tag[1]!),
      );
      return r
        ? new Response(JSON.stringify(r), { status: 200 })
        : new Response("not found", { status: 404 });
    }
    const a = /\/releases\/assets\/(\d+)$/.exec(url);
    if (a) {
      assetFetches += 1;
      const body = opts.assets?.[Number(a[1])];
      return body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 });
    }
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files)) {
        if (url.includes(`/contents/${path}`))
          return new Response(
            JSON.stringify({
              content: Buffer.from(body, "utf8").toString("base64"),
              encoding: "base64",
            }),
            { status: 200 },
          );
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, assetFetches: () => assetFetches };
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

async function batch(db: Db, stmts: DbStatement[]): Promise<void> {
  await db.batch(stmts);
}

/** A linked product with `release_config`; `withMap` also persists the declaration. */
async function seedLinked(db: Db, withMap = true): Promise<void> {
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET release_source = 'github' WHERE slug = ?",
    SLUG,
  );
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, beta_branch, binary_name, summary_marker,
        metadata_access, artifacts_access)
     VALUES (?, ?, ?, 42, 'main', 'diceroll', 'pkey:summary', 'public', 'public')`,
    SLUG,
    OWNER,
    REPO,
  );
  if (withMap)
    await batch(db, manifestDeliverableStatements(SLUG, appDeclaration(), NOW));
}

/** Record a verified object the way `promote` does (P2-01). */
async function storeBlob(db: Db, hash: string, size: number): Promise<string> {
  const key = `blobs/sha256/${hash}`;
  await db.run(
    `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
     VALUES (?, ?, ?, 'blob', 0, ?, ?)`,
    key,
    hash,
    size,
    NOW,
    NOW,
  );
  return key;
}

const TABLES = [
  "release_metadata",
  "release_artifacts",
  "release_builds",
  "release_deliverables",
  "release_channel_policy",
  "release_health",
  "blob_refs",
] as const;

/** Every row of every table ingest can touch, for "writes nothing" and "changes no row". */
async function dump(db: Db): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES)
    out[t] = await db.all(`SELECT * FROM ${t} ORDER BY 1, 2, 3`);
  return out;
}

// ── The descriptor ───────────────────────────────────────────────────────────

const WEB_BYTES = "web build bytes";
const WEB_SHA = sha(WEB_BYTES);

/** A descriptor for v1.2.3: the macOS build on GitHub (with its signature), the web build in R2. */
function descriptor(): Record<string, any> {
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version: "1.2.3",
    tag: "v1.2.3",
    channel: "stable",
    title: "Diceroll 1.2.3",
    publishedAt: "2026-09-01T00:00:00Z",
    provenance: {
      commit: "0123456789abcdef0123456789abcdef01234567",
      workflowRun: `https://github.com/${OWNER}/${REPO}/actions/runs/9`,
    },
    builds: [
      {
        id: "macos",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        buildNumber: "4021",
        minOS: "13.0",
        artifacts: [
          {
            name: "Diceroll-1.2.3-macos.dmg",
            role: "payload",
            sha256: sha("Diceroll-1.2.3-macos.dmg"),
            size: 1101,
            locations: [
              { provider: "github", asset: "Diceroll-1.2.3-macos.dmg" },
            ],
          },
          {
            name: "Diceroll-1.2.3-macos.dmg.sig",
            role: "signature",
            sha256: sha("Diceroll-1.2.3-macos.dmg.sig"),
            size: 1102,
            locations: [
              { provider: "github", asset: "Diceroll-1.2.3-macos.dmg.sig" },
            ],
          },
        ],
      },
      {
        id: "web",
        platform: "web",
        arch: "wasm32",
        format: "zip",
        artifacts: [
          {
            name: "Diceroll-1.2.3-web.zip",
            role: "payload",
            sha256: WEB_SHA,
            size: WEB_BYTES.length,
            locations: [{ provider: "r2", key: `blobs/sha256/${WEB_SHA}` }],
          },
        ],
      },
    ],
  };
}

/** A descriptor with no GitHub at all: an R2-only, untagged release. */
function r2Descriptor(version = "1.3.0"): Record<string, any> {
  const d = descriptor();
  d.version = version;
  delete d.tag;
  d.builds = [d.builds[1]];
  d.builds[0].artifacts[0].name = `Diceroll-${version}-web.zip`;
  return d;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1. Map classification
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("a Diceroll-shaped release is classified by the declared map", () => {
  it("resync writes six builds with the declared platform and arch, and the sidecar joins its payload", async () => {
    const db = makeTestDb();
    await seedLinked(db, false);
    const { fetchImpl } = github([ghRelease()]);
    const res = await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    expect(res).toMatchObject({ ok: true });

    const builds = await listBuilds(db, SLUG, "v1.2.3");
    expect(
      builds.map((b) => [b.build_id, b.platform, b.arch, b.format]),
    ).toEqual([
      ["apk", "android", "any", "apk"],
      ["ipa-sideload", "ios", "arm64", "ipa"],
      ["linux-x64", "linux", "x86_64", "tar.gz"],
      ["macos", "macos", "universal", "dmg"],
      ["web", "web", "wasm32", "zip"],
      ["win-zip", "windows", "x86_64", "zip"],
    ]);

    const artifacts = await listReleaseArtifacts(db, SLUG, "v1.2.3");
    const byName = new Map(artifacts.map((a) => [a.name, a]));
    expect(byName.get("Diceroll-1.2.3-macos.dmg")).toMatchObject({
      build_id: "macos",
      role: "payload",
      platform: "macos",
      arch: "universal",
      // GitHub's own digest of the bytes.
      sha256: sha("Diceroll-1.2.3-macos.dmg"),
    });
    expect(byName.get("Diceroll-1.2.3-macos.dmg.sig")).toMatchObject({
      build_id: "macos",
      role: "signature",
    });
    expect(byName.get("Diceroll-1.2.3-android.apk")).toMatchObject({
      build_id: "apk",
      platform: "android",
      arch: "any",
    });
    expect(byName.get("Diceroll-1.2.3-ios-sideload.ipa")).toMatchObject({
      build_id: "ipa-sideload",
      platform: "ios",
      arch: "arm64",
    });

    // The declaration itself, and the channel's includes, are persisted.
    const app = await getDeliverable(db, SLUG, "app");
    expect(JSON.parse(app!.def_json!)).toEqual(appDeclaration());
    expect(app!.def_source).toBe("manifest");
    const beta = await getChannelPolicy(db, {
      product: SLUG,
      deliverableId: "app",
      channel: "beta",
    });
    expect(JSON.parse(beta!.includes_json!)).toEqual(["stable"]);
  });

  it("the same release without a map is sniffed exactly as before", async () => {
    const db = makeTestDb();
    await seedLinked(db, false);
    const { fetchImpl } = github([ghRelease()], { withMap: false });
    await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);

    expect(await listBuilds(db, SLUG, "v1.2.3")).toEqual([]);
    const artifacts = await listReleaseArtifacts(db, SLUG, "v1.2.3");
    expect(
      Object.fromEntries(
        artifacts.map((a) => [
          a.name,
          [a.kind, a.platform, a.arch, a.role, a.build_id, a.sha256],
        ]),
      ),
    ).toEqual({
      "Diceroll-1.2.3-macos.dmg": ["dmg", "macos", null, "payload", null, null],
      "Diceroll-1.2.3-macos.dmg.sig": [
        "signature",
        "macos",
        null,
        "signature",
        null,
        null,
      ],
      "Diceroll-1.2.3-windows-x86_64.zip": [
        "archive",
        "windows",
        "x86_64",
        "payload",
        null,
        null,
      ],
      "Diceroll-1.2.3-linux-x86_64.tar.gz": [
        "archive",
        "linux",
        "x86_64",
        "payload",
        null,
        null,
      ],
      "Diceroll-1.2.3-android.apk": [
        "other",
        null,
        null,
        "payload",
        null,
        null,
      ],
      "Diceroll-1.2.3-ios-sideload.ipa": [
        "other",
        null,
        null,
        "payload",
        null,
        null,
      ],
      "Diceroll-1.2.3-web.zip": ["archive", null, null, "payload", null, null],
    });
    // No map ⇒ the deliverable row carries no declaration.
    expect((await getDeliverable(db, SLUG, "app"))!.def_json).toBeNull();
  });

  it("without a map, the store's artifact statements are the pre-P2-04 ones", () => {
    const cfg = {
      product: SLUG,
      gh_owner: OWNER,
      gh_repo: REPO,
      gh_installation_id: 42,
      channel_workflow: null,
      beta_branch: "main",
      manual_channels_json: null,
      binary_name: "diceroll",
      install_template: null,
      sparkle_ed25519_pub: null,
      summary_marker: "pkey:summary",
      artifact_policy_json: null,
    };
    const plain = releaseStoreStatements(SLUG, cfg, [ghRelease()], NOW);
    const noMap = releaseStoreStatements(
      SLUG,
      cfg,
      [ghRelease()],
      NOW,
      [],
      [],
      null,
      {
        app: null,
      },
    );
    expect(noMap).toEqual(plain);
    const artifactSql = plain.filter((s) =>
      s.sql.includes("INSERT INTO release_artifacts"),
    );
    expect(artifactSql).toHaveLength(FILES.length);
    for (const s of artifactSql) {
      // Role filled when NULL and never overwritten — unless a removed map had set it.
      expect(s.sql).toContain(
        "THEN COALESCE(release_artifacts.role, excluded.role)",
      );
      expect(s.sql).not.toContain("build_id = excluded.build_id");
      expect(s.sql).not.toContain("sha256 =");
    }
  });

  it("a map change re-classifies an undescribed release and drops builds it no longer yields", async () => {
    const db = makeTestDb();
    await seedLinked(db, false);
    const { fetchImpl } = github([ghRelease()]);
    await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    expect(await listBuilds(db, SLUG, "v1.2.3")).toHaveLength(6);

    // The manifest drops its map: sniffing again, and no map-made build survives.
    const { fetchImpl: noMap } = github([ghRelease()], { withMap: false });
    await resyncRepo(envFor(), db, SLUG, NOW + 60, noMap);
    expect(await listBuilds(db, SLUG, "v1.2.3")).toEqual([]);
    const dmg = (await listReleaseArtifacts(db, SLUG, "v1.2.3")).find(
      (a) => a.name === "Diceroll-1.2.3-macos.dmg",
    )!;
    expect(dmg.build_id).toBeNull();
    // ...and the manifest-owned includes go with the declaration.
    expect((await getDeliverable(db, SLUG, "app"))!.def_json).toBeNull();
    const beta = await getChannelPolicy(db, {
      product: SLUG,
      deliverableId: "app",
      channel: "beta",
    });
    expect(beta!.includes_json).toBeNull();
  });

  it("an entry matching two files classifies neither (ambiguous by design)", async () => {
    const db = makeTestDb();
    await seedLinked(db, false);
    const twoDmgs = ghRelease({
      assets: [
        asset("Diceroll-1.2.3-macos.dmg", 101),
        asset("Diceroll-1.2.3-beta-macos.dmg", 108),
      ],
    });
    const { fetchImpl } = github([twoDmgs]);
    await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    expect(await listBuilds(db, SLUG, "v1.2.3")).toEqual([]);
    for (const a of await listReleaseArtifacts(db, SLUG, "v1.2.3"))
      expect([a.build_id, a.platform, a.arch]).toEqual([null, null, null]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2. CI ingest
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function ciSetup(releases: Release[] = [ghRelease()]) {
  const db = makeTestDb();
  await seedLinked(db);
  const webKey = await storeBlob(db, WEB_SHA, WEB_BYTES.length);
  const { fetchImpl } = github(releases);
  const ingest = (d: unknown, over: Record<string, unknown> = {}) =>
    ingestReleaseDescriptor(db, envFor(), SLUG, d, {
      source: "ci",
      now: NOW + 100,
      promoted: [webKey],
      fetchImpl,
      ...over,
    });
  return { db, webKey, ingest, fetchImpl };
}

describe("ingestReleaseDescriptor (CI)", () => {
  it("writes the release, its builds, its files and the blob ref in one pass", async () => {
    const { db, webKey, ingest } = await ciSetup();
    const res = await ingest(descriptor());
    expect(res).toMatchObject({
      ok: true,
      releaseId: "v1.2.3",
      outcome: "created",
      dryRun: false,
    });

    const [meta] = await listReleaseMetadata(db, SLUG);
    expect(meta).toMatchObject({
      release_id: "v1.2.3",
      version: "1.2.3",
      deliverable_id: "app",
      seq: 1,
      channel: "stable",
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(JSON.parse(meta!.metadata_json!).descriptor).toMatchObject({
      status: "ingested",
      source: "ci",
    });

    const builds = await listBuilds(db, SLUG, "v1.2.3");
    expect(builds.map((b) => [b.build_id, b.build_number, b.min_os])).toEqual([
      ["macos", "4021", "13.0"],
      ["web", null, null],
    ]);

    const artifacts = await listReleaseArtifacts(db, SLUG, "v1.2.3");
    const dmg = artifacts.find((a) => a.name === "Diceroll-1.2.3-macos.dmg")!;
    expect(dmg).toMatchObject({
      // GitHub's asset id, so the sync recognises the row as its own.
      artifact_id: "101",
      build_id: "macos",
      role: "payload",
      platform: "macos",
      arch: "universal",
      sha256: sha("Diceroll-1.2.3-macos.dmg"),
      content_type: "application/x-apple-diskimage",
      source_url: `https://github.com/${OWNER}/${REPO}/releases/download/v1.2.3/Diceroll-1.2.3-macos.dmg`,
    });
    const web = artifacts.find((a) => a.name === "Diceroll-1.2.3-web.zip")!;
    expect(web).toMatchObject({
      // GitHub has the file too, so the row takes its asset id: the sync will not add a second.
      artifact_id: "107",
      storage_key: webKey,
      build_id: "web",
    });
    expect(
      await db.all(
        "SELECT product, storage_key, ref_kind, ref_id FROM blob_refs",
      ),
    ).toEqual([
      {
        product: SLUG,
        storage_key: webKey,
        ref_kind: "artifact",
        ref_id: "v1.2.3/107",
      },
    ]);
  });

  it("an untagged R2-only release is <deliverable>@<version>", async () => {
    const { db, webKey, ingest } = await ciSetup([]);
    const res = await ingest(r2Descriptor());
    expect(res).toMatchObject({ ok: true, releaseId: "app@1.3.0" });
    const [a] = await listReleaseArtifacts(db, SLUG, "app@1.3.0");
    expect(a).toMatchObject({
      artifact_id: "file:Diceroll-1.3.0-web.zip",
      storage_key: webKey,
      source_url: null,
    });
  });

  it("a CI-only release is not flagged absent upstream by a later GitHub sync", async () => {
    const { db, ingest, fetchImpl } = await ciSetup([]);
    expect(await ingest(r2Descriptor())).toMatchObject({ ok: true });
    await syncReleaseStore(envFor(), db, SLUG, NOW + 200, fetchImpl);
    const health = await listReleaseHealth(db, SLUG);
    expect(health.find((h) => h.subject_id === "app@1.3.0")).toBeUndefined();
    expect(await listReleaseMetadata(db, SLUG)).toHaveLength(1);
  });

  it("re-ingesting the same descriptor changes no row", async () => {
    const { db, ingest } = await ciSetup();
    expect(await ingest(descriptor())).toMatchObject({ ok: true });
    const before = await dump(db);
    // Key order is not content: the canonical form is what is compared.
    const reordered = Object.fromEntries(
      Object.entries(descriptor()).reverse(),
    );
    const again = await ingest(reordered);
    expect(again).toMatchObject({ ok: true, outcome: "unchanged" });
    expect(await dump(db)).toEqual(before);
  });

  it("dryRun returns the planned rows and writes nothing", async () => {
    const { db, ingest } = await ciSetup();
    const before = await dump(db);
    const res = await ingest(descriptor(), { dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dryRun).toBe(true);
    expect(res.planned?.release).toMatchObject({
      releaseId: "v1.2.3",
      version: "1.2.3",
      channel: "stable",
    });
    expect(res.planned?.builds.map((b) => b.buildId)).toEqual(["macos", "web"]);
    expect(res.planned?.artifacts.map((a) => [a.name, a.artifactId])).toEqual([
      ["Diceroll-1.2.3-macos.dmg", "101"],
      ["Diceroll-1.2.3-macos.dmg.sig", "102"],
      ["Diceroll-1.2.3-web.zip", "107"],
    ]);
    expect(res.planned?.blobRefs).toHaveLength(1);
    expect(await dump(db)).toEqual(before);
  });

  const REFUSALS: {
    name: string;
    reason: string;
    code?: string;
    setup?: (db: Db) => Promise<void>;
    releases?: Release[];
    mutate?: (d: Record<string, any>) => void;
    promoted?: string[];
  }[] = [
    {
      name: "an undeclared build id",
      reason: "invalid_descriptor",
      code: "undeclared_build",
      mutate: (d) => (d.builds[1].id = "web-gl"),
    },
    {
      name: "a name not matching the entry's match",
      reason: "invalid_descriptor",
      code: "artifact_name_mismatch",
      mutate: (d) => {
        d.builds[1].artifacts[0].name = "diceroll-web.zip";
      },
    },
    {
      name: "a platform mismatch",
      reason: "invalid_descriptor",
      code: "build_mismatch",
      mutate: (d) => (d.builds[1].platform = "linux"),
    },
    {
      name: "a non-content-addressed r2 key",
      reason: "invalid_descriptor",
      code: "r2_key_not_content_addressed",
      mutate: (d) =>
        (d.builds[1].artifacts[0].locations[0].key = `blobs/sha256/${"0".repeat(64)}`),
    },
    {
      name: "a mutable GitHub release",
      reason: "release_mutable",
      releases: [ghRelease({ immutable: false })],
    },
    {
      name: "a GitHub digest that differs from the descriptor",
      reason: "digest_mismatch",
      mutate: (d) => (d.builds[0].artifacts[0].sha256 = "f".repeat(64)),
    },
    {
      name: "a lower seq",
      reason: "seq_not_increasing",
      setup: async (db) => {
        await db.run(
          `INSERT INTO release_metadata
             (product, release_id, version, metadata_access, artifacts_access, created_at,
              modified_at, deliverable_id, seq)
           VALUES (?, 'v1.1.0', '1.1.0', 'public', 'public', ?, ?, 'app', 5)`,
          SLUG,
          NOW,
          NOW,
        );
      },
      mutate: (d) => (d.seq = 3),
    },
    {
      name: "an r2 key this product neither promoted nor references",
      reason: "r2_ref_not_owned",
      promoted: [],
    },
    {
      name: "a GitHub tag that does not exist",
      reason: "github_release_not_found",
      releases: [],
    },
  ];

  for (const r of REFUSALS) {
    it(`refuses ${r.name}, writing nothing`, async () => {
      const { db, ingest } = await ciSetup(r.releases);
      await r.setup?.(db);
      const d = descriptor();
      r.mutate?.(d);
      const before = await dump(db);
      const res = await ingest(
        d,
        r.promoted !== undefined ? { promoted: r.promoted } : {},
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.reason).toBe(r.reason);
      if (r.code) expect(res.errors?.map((e) => e.code)).toContain(r.code);
      expect(await dump(db)).toEqual(before);
    });
  }

  it("refuses a conflicting re-submission, writing nothing", async () => {
    const { db, ingest } = await ciSetup();
    expect(await ingest(descriptor())).toMatchObject({ ok: true });
    const before = await dump(db);
    const changed = descriptor();
    changed.title = "Diceroll 1.2.3 (respin)";
    const res = await ingest(changed);
    expect(res).toMatchObject({
      ok: false,
      reason: "release_exists",
      status: 409,
    });
    expect(await dump(db)).toEqual(before);
  });

  it("refuses a second release of the same version under another id", async () => {
    const { db, ingest } = await ciSetup([]);
    expect(await ingest(r2Descriptor("1.3.0"))).toMatchObject({ ok: true });
    const before = await dump(db);
    const tagged = r2Descriptor("1.3.0");
    tagged.tag = "v1.3.0";
    const res = await ingest(tagged);
    expect(res).toMatchObject({ ok: false, reason: "release_exists" });
    expect(await dump(db)).toEqual(before);
  });

  it("seq: absent takes the next one; present must exceed the maximum", async () => {
    const { db, ingest } = await ciSetup([]);
    expect(await ingest(r2Descriptor("1.3.0"))).toMatchObject({ ok: true });
    const explicit = r2Descriptor("1.4.0");
    explicit.seq = 10;
    expect(await ingest(explicit)).toMatchObject({ ok: true });
    const seqs = Object.fromEntries(
      (await listReleaseMetadata(db, SLUG)).map((m) => [m.version, m.seq]),
    );
    expect(seqs).toEqual({ "1.3.0": 1, "1.4.0": 10 });
    const equal = r2Descriptor("1.5.0");
    equal.seq = 10;
    expect(await ingest(equal)).toMatchObject({
      ok: false,
      reason: "seq_not_increasing",
    });
  });

  it("an r2 key the product already references needs no promotion", async () => {
    const { db, webKey, ingest } = await ciSetup([]);
    await recordRef(
      db,
      { product: SLUG, storageKey: webKey, refKind: "artifact", refId: "x" },
      NOW,
    );
    expect(await ingest(r2Descriptor(), { promoted: [] })).toMatchObject({
      ok: true,
    });
  });

  it("enriches the row the GitHub sync created for the same tag", async () => {
    const { db, ingest, fetchImpl } = await ciSetup();
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    const rowsBefore = (await listReleaseArtifacts(db, SLUG, "v1.2.3")).length;
    const seqBefore = (await listReleaseMetadata(db, SLUG))[0]!.seq;

    // The sync recorded every file, so the descriptor must name every one of them.
    const d = descriptor();
    for (const [i, name] of FILES.entries()) {
      const known = d.builds.flatMap((b: any) =>
        b.artifacts.map((a: any) => a.name),
      );
      if (known.includes(name)) continue;
      const entry = ARTIFACTS.find((e) =>
        new RegExp(
          `^${e.match.replace(/[.]/g, "\\.").replace("*", ".*")}$`,
        ).test(name),
      )!;
      d.builds.push({
        id: entry.id,
        platform: entry.platform,
        arch: entry.arch,
        format: entry.format,
        artifacts: [
          {
            name,
            role: "payload",
            sha256: sha(name),
            size: 1101 + i,
            locations: [{ provider: "github", asset: name }],
          },
        ],
      });
    }
    // web is on GitHub too; keep the R2 copy as a second location.
    d.builds[1].artifacts[0].locations.push({
      provider: "github",
      asset: "Diceroll-1.2.3-web.zip",
    });
    d.builds[1].artifacts[0].sha256 = sha("Diceroll-1.2.3-web.zip");
    d.builds[1].artifacts[0].size = 1107;
    d.builds[1].artifacts[0].locations[0].key = `blobs/sha256/${sha("Diceroll-1.2.3-web.zip")}`;
    const key = await storeBlob(db, sha("Diceroll-1.2.3-web.zip"), 1107);

    const res = await ingest(d, { promoted: [key] });
    expect(res).toMatchObject({ ok: true, outcome: "enriched" });
    const after = await listReleaseArtifacts(db, SLUG, "v1.2.3");
    expect(after).toHaveLength(rowsBefore);
    expect((await listReleaseMetadata(db, SLUG))[0]!.seq).toBe(seqBefore);
    const builds = await listBuilds(db, SLUG, "v1.2.3");
    expect(builds.find((b) => b.build_id === "macos")!.build_number).toBe(
      "4021",
    );

    // A later resync leaves the descriptor's facts alone.
    await syncReleaseStore(envFor(), db, SLUG, NOW + 200, fetchImpl);
    expect(await listBuilds(db, SLUG, "v1.2.3")).toEqual(builds);
    expect(await listReleaseArtifacts(db, SLUG, "v1.2.3")).toHaveLength(
      rowsBefore,
    );
  });

  it("refuses to enrich a synced row when it places on GitHub a file the row does not hold", async () => {
    const { db, ingest, fetchImpl } = await ciSetup();
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    const before = await dump(db);
    const d = descriptor();
    d.builds[0].artifacts.push({
      name: "Diceroll-1.2.3-macos.dmg.minisig",
      role: "signature",
      sha256: sha("minisig"),
      size: 64,
      locations: [
        { provider: "github", asset: "Diceroll-1.2.3-macos.dmg.minisig" },
      ],
    });
    const res = await ingest(d);
    expect(res).toMatchObject({ ok: false, reason: "release_exists" });
    expect(await dump(db)).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 3. The GitHub path
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** The descriptor CI would attach: every file of the release on GitHub. */
function attachedDescriptor(): Record<string, any> {
  const builds = ARTIFACTS.map((e) => {
    const payload = FILES.find((n) =>
      new RegExp(`^${e.match.replace(/[.]/g, "\\.").replace("*", ".*")}$`).test(
        n,
      ),
    )!;
    const file = (name: string, role: string) => ({
      name,
      role,
      sha256: sha(name),
      size: 1101 + FILES.indexOf(name),
      locations: [{ provider: "github", asset: name }],
    });
    return {
      id: e.id,
      platform: e.platform,
      arch: e.arch,
      format: e.format,
      buildNumber: "77",
      artifacts: [
        file(payload, "payload"),
        ...(FILES.includes(`${payload}.sig`)
          ? [file(`${payload}.sig`, "signature")]
          : []),
      ],
    };
  });
  return {
    descriptorVersion: 1,
    product: SLUG,
    deliverable: "app",
    kind: "app",
    version: "1.2.3",
    tag: "v1.2.3",
    builds,
  };
}

function withDescriptorAsset(over: Partial<Release> = {}): Release {
  const r = ghRelease(over);
  r.assets.push({ ...asset("pkey-release.json", 200), digest: null });
  return r;
}

describe("the GitHub path: pkey-release.json during the truth-store sync", () => {
  it("ingests an attached descriptor once, then stops fetching it", async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const { fetchImpl, assetFetches } = github([withDescriptorAsset()], {
      assets: { 200: JSON.stringify(attachedDescriptor()) },
    });
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    expect(assetFetches()).toBe(1);

    const [meta] = await listReleaseMetadata(db, SLUG);
    expect(JSON.parse(meta!.metadata_json!).descriptor).toMatchObject({
      status: "ingested",
      source: "github",
    });
    const builds = await listBuilds(db, SLUG, "v1.2.3");
    expect(builds).toHaveLength(6);
    expect(new Set(builds.map((b) => b.build_number))).toEqual(new Set(["77"]));
    const health = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_id === "v1.2.3",
    )!;
    expect(health.status).toBe("healthy");

    const before = await listBuilds(db, SLUG, "v1.2.3");
    await syncReleaseStore(envFor(), db, SLUG, NOW + 60, fetchImpl);
    expect(assetFetches()).toBe(1);
    expect(await listBuilds(db, SLUG, "v1.2.3")).toEqual(before);
  });

  it("a mutable release is refused into release_health, and not re-fetched", async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const { fetchImpl, assetFetches } = github(
      [withDescriptorAsset({ immutable: false })],
      { assets: { 200: JSON.stringify(attachedDescriptor()) } },
    );
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    const health = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_id === "v1.2.3",
    )!;
    expect(health.status).toBe("degraded");
    expect(JSON.parse(health.details_json!)).toMatchObject({
      descriptor: { refused: "release_mutable" },
    });
    // The map still classifies the files; only the descriptor was refused.
    expect(await listBuilds(db, SLUG, "v1.2.3")).toHaveLength(6);

    await syncReleaseStore(envFor(), db, SLUG, NOW + 60, fetchImpl);
    expect(assetFetches()).toBe(1);
    const again = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_id === "v1.2.3",
    )!;
    expect(again.status).toBe("degraded");
  });

  it("a digest mismatch is refused with its reason", async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const bad = attachedDescriptor();
    bad.builds[0].artifacts[0].sha256 = "e".repeat(64);
    const { fetchImpl } = github([withDescriptorAsset()], {
      assets: { 200: JSON.stringify(bad) },
    });
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    const health = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_id === "v1.2.3",
    )!;
    expect(JSON.parse(health.details_json!).descriptor).toEqual({
      refused: "digest_mismatch",
    });
    const [meta] = await listReleaseMetadata(db, SLUG);
    expect(JSON.parse(meta!.metadata_json!).descriptor).toMatchObject({
      status: "refused",
      reason: "digest_mismatch",
      assetId: 200,
    });
  });

  it("an explicit seq on a release first seen in this sync is taken before the store numbers the rest", async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const d = attachedDescriptor();
    d.seq = 1;
    const older = ghRelease({
      tag_name: "v1.1.0",
      published_at: "2026-08-01T00:00:00Z",
      assets: [asset("Diceroll-1.1.0-macos.dmg", 90, "v1.1.0")],
    });
    const { fetchImpl } = github([withDescriptorAsset(), older], {
      assets: { 200: JSON.stringify(d) },
    });
    expect(
      await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl),
    ).toBeGreaterThan(0);
    const seqs = Object.fromEntries(
      (await listReleaseMetadata(db, SLUG)).map((m) => [m.release_id, m.seq]),
    );
    expect(seqs).toEqual({ "v1.2.3": 1, "v1.1.0": 2 });
  });

  it("an oversized pkey-release.json is refused without being fetched", async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const r = ghRelease();
    r.assets.push({ ...asset("pkey-release.json", 200), size: 70_000 });
    const { fetchImpl, assetFetches } = github([r], { assets: { 200: "{}" } });
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    expect(assetFetches()).toBe(0);
    const health = (await listReleaseHealth(db, SLUG)).find(
      (h) => h.subject_id === "v1.2.3",
    )!;
    expect(JSON.parse(health.details_json!).descriptor).toEqual({
      refused: "invalid_descriptor",
    });
  });

  it(`fetches at most ${MAX_DESCRIPTOR_FETCHES_PER_SYNC} descriptors per sync`, async () => {
    const db = makeTestDb();
    await seedLinked(db);
    const releases = Array.from({ length: 8 }, (_, i) => ({
      ...ghRelease({
        tag_name: `v1.${i}.0`,
        published_at: `2026-09-0${i + 1}T00:00:00Z`,
        assets: [],
      }),
      assets: [{ ...asset("pkey-release.json", 300 + i), digest: null }],
    }));
    const { fetchImpl, assetFetches } = github(releases, { assets: {} });
    await syncReleaseStore(envFor(), db, SLUG, NOW, fetchImpl);
    expect(assetFetches()).toBe(MAX_DESCRIPTOR_FETCHES_PER_SYNC);
  });
});
