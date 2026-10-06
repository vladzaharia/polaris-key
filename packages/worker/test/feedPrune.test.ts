/**
 * Feed retention (owner request 2026-10-06): a stable publish prunes the package's builds of main
 * below it (`services/release/packages/prune.ts`). Per-ecosystem metadata after a prune, the
 * shared-blob refcount, idempotency, beta never prunes, newer prereleases are kept, the npm
 * dist-tag, dry run against apply, failure isolation, the setting and its defaults (off for a
 * tenant product, locked on for the system product), the tombstone, and the safety points: the
 * channel filter, other products, odd version spellings, a yanked stable, the per-run cap, a
 * partial failure, versions held between plan and apply, and the blob collector's mark.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PACKAGE_ECOSYSTEM_RULES,
  SYSTEM_PRODUCT_SLUG,
  type ManifestPackageDeliverable,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { asR2, R2Mock } from "./r2Mock.js";
import type { Db } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import { manifestDeliverableStatements } from "../src/services/release/deliverables.js";
import { packageCatalog } from "../src/services/release/packages/catalog.js";
import {
  applyPackagePrune,
  compareRelease,
  finalRelease,
  mainPrerelease,
  newestStable,
  planPackagePrune,
  PRUNE_MAX_PER_RUN,
  pruneAfterStablePublish,
  prunePackages,
  pruneRetentionOf,
  PRUNE_SETTING_KEY,
  retentionLocked,
  SYSTEM_PRUNE_ACTOR,
  triggersPrune,
} from "../src/services/release/packages/prune.js";
import { catalogPackageSource } from "../src/services/distribution/registry/catalogSource.js";
import {
  FEED_ADAPTERS,
  RENDERERS,
} from "../src/services/distribution/registry/index.js";
import {
  materialise,
  renderRecordKey,
  type RenderedObject,
} from "../src/services/distribution/registry/materialise.js";
import { stmtSetChannelPolicy } from "../src/services/release/model.js";
import { markUnreferenced } from "../src/core/blobGc.js";
import { SETTINGS } from "../src/mount.js";
import { writeSetting } from "../src/core/settings/write.js";

const P = "acme";
const hex = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Db;
let env: Env;

/** Per ecosystem: the package, its file shapes and metadata, and its version spellings. */
interface Shape {
  name: string;
  files(v: string): { name: string; type: string; extra?: object }[];
  metadata(v: string): Record<string, unknown>;
  /** stable 1.0.0, main builds of 1.1.0 (1, 2), an older main 1.0.0 (9), beta, newer main. */
  v: {
    stable0: string;
    main1: string;
    main2: string;
    oldMain: string;
    beta: string;
    newerMain: string;
    stable: string;
  };
}

const SEMVER = {
  stable0: "1.0.0",
  main1: "1.1.0-main.1",
  main2: "1.1.0-main.2",
  oldMain: "1.0.0-main.9",
  beta: "1.1.0-rc.1",
  newerMain: "1.1.1-main.1",
  stable: "1.1.0",
};
const PEP440 = {
  stable0: "1.0.0",
  main1: "1.1.0.dev1",
  main2: "1.1.0.dev2",
  oldMain: "1.0.0.dev9",
  beta: "1.1.0rc1",
  newerMain: "1.1.1.dev1",
  stable: "1.1.0",
};
const OCI = "application/vnd.oci.image.manifest.v1+json";

const SHAPES: Record<PackageEcosystem, Shape> = {
  npm: {
    name: "@acme/sdk",
    files: (v) => [{ name: `sdk-${v}.tgz`, type: "npm-tarball" }],
    metadata: (v) => ({ name: "@acme/sdk", version: v }),
    v: SEMVER,
  },
  pypi: {
    name: "acme-sdk",
    files: (v) => [{ name: `acme_sdk-${v}-py3-none-any.whl`, type: "wheel" }],
    metadata: (v) => ({ name: "acme-sdk", version: v }),
    v: PEP440,
  },
  swift: {
    name: "acme.Sdk",
    files: (v) => [
      { name: `Sdk-${v}.zip`, type: "source-archive" },
      { name: "Package.swift", type: "manifest" },
    ],
    metadata: (v) => ({ name: "acme.Sdk", version: v }),
    v: SEMVER,
  },
  maven: {
    name: "com.acme:sdk",
    files: (v) => [
      { name: `sdk-${v}.jar`, type: "maven-file", extra: { extension: "jar" } },
      { name: `sdk-${v}.pom`, type: "maven-file", extra: { extension: "pom" } },
    ],
    metadata: (v) => ({
      name: "com.acme:sdk",
      version: v,
      groupId: "com.acme",
      artifactId: "sdk",
      packaging: "jar",
    }),
    v: SEMVER,
  },
  oci: {
    name: "app",
    files: () => [
      {
        name: "manifest.json",
        type: "oci-manifest",
        extra: { mediaType: OCI },
      },
    ],
    metadata: (v) => ({
      name: "app",
      version: v,
      mediaType: OCI,
      root: `sha256:${hex(`oci:app:${v}:manifest.json`)}`,
    }),
    v: SEMVER,
  },
  godot: {
    name: "acme_tool",
    files: (v) => [{ name: `acme_tool-${v}.zip`, type: "godot-zip" }],
    metadata: (v) => ({
      name: "acme_tool",
      version: v,
      displayName: "Acme Tool",
      author: "Acme",
      description: "Sample",
    }),
    v: SEMVER,
  },
  cargo: {
    name: "acme-sdk",
    files: (v) => [{ name: `acme-sdk-${v}.crate`, type: "crate" }],
    metadata: (v) => ({ name: "acme-sdk", version: v, deps: [], features: {} }),
    v: SEMVER,
  },
  go: {
    name: "go.acme.dev/Sdk",
    files: (v) => [
      { name: `v${v}.zip`, type: "go-zip" },
      { name: "go.mod", type: "go-mod" },
    ],
    metadata: (v) => ({ name: "go.acme.dev/Sdk", version: v, h1: `h1:${v}` }),
    v: SEMVER,
  },
};

const ECOS = Object.keys(SHAPES) as PackageEcosystem[];
const did = (eco: string) => `${eco}.sdk`;

async function declare(product: string, ecos: readonly PackageEcosystem[]) {
  const decls: ManifestPackageDeliverable[] = ecos.map((e) => ({
    kind: "package",
    id: did(e),
    ecosystem: e,
    name: SHAPES[e].name,
    artifacts: { file: { match: "*" } },
  }));
  await db.batch(manifestDeliverableStatements(product, null, NOW, [], decls));
}

let seq = 0;

/**
 * One package version as ingest writes it: the release row, a payload artifact and an `artifact`
 * blob ref per file (the object recorded first), the `release_packages` row. `shared` names a
 * content seed so two versions can hold the same content-addressed blob.
 */
async function publishRow(
  eco: PackageEcosystem,
  version: string,
  channel: string,
  opts: { product?: string; shared?: string; size?: number } = {},
): Promise<string> {
  const product = opts.product ?? P;
  const shape = SHAPES[eco];
  const releaseId = `${did(eco)}@${version}`;
  seq++;
  const stmts = [
    {
      sql: `INSERT INTO release_metadata (product, release_id, version, metadata_access,
              artifacts_access, published_at, created_at, modified_at, deliverable_id, seq, channel)
            VALUES (?, ?, ?, 'public', 'public', ?, ?, ?, ?, ?, ?)`,
      params: [
        product,
        releaseId,
        version,
        NOW + seq,
        NOW,
        NOW,
        did(eco),
        seq,
        channel,
      ],
    },
  ];
  const files: Record<string, unknown>[] = [];
  for (const f of shape.files(version)) {
    const sha = hex(opts.shared ?? `${eco}:${shape.name}:${version}:${f.name}`);
    const size = opts.size ?? 1000;
    const key = `blobs/sha256/${sha}`;
    stmts.push(
      {
        sql: `INSERT INTO blob_objects (storage_key, sha256, size, kind, verified_at, created_at)
              VALUES (?, ?, ?, 'blob', ?, ?) ON CONFLICT(storage_key) DO NOTHING`,
        params: [key, sha, size, NOW, NOW],
      },
      {
        sql: `INSERT INTO release_artifacts (product, release_id, artifact_id, name, kind,
                content_type, size_bytes, sha256, storage_key, access, metadata_json, created_at,
                role, locations_json)
              VALUES (?, ?, ?, ?, 'package', 'application/octet-stream', ?, ?, ?, 'public', '{}',
                      ?, 'payload', ?)`,
        params: [
          product,
          releaseId,
          `file:${f.name}`,
          f.name,
          size,
          sha,
          key,
          NOW,
          JSON.stringify([{ provider: "r2", key }]),
        ],
      },
      {
        sql: `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
              VALUES (?, ?, 'artifact', ?, ?)`,
        params: [product, key, `${releaseId}/file:${f.name}`, NOW],
      },
    );
    files.push({ name: f.name, type: f.type, sha256: sha, size, ...f.extra });
  }
  stmts.push({
    sql: `INSERT INTO release_packages (product, ecosystem, name_norm, version, deliverable_id,
            release_id, name, files_json, metadata_json, source_json, published_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    params: [
      product,
      eco,
      PACKAGE_ECOSYSTEM_RULES[eco].name.norm(shape.name),
      version,
      did(eco),
      releaseId,
      shape.name,
      JSON.stringify(files),
      JSON.stringify(shape.metadata(version)),
      NOW + seq,
    ],
  });
  await db.batch(stmts);
  return releaseId;
}

/** The standard history of one package, up to (not including) the stable 1.1.0. */
async function history(eco: PackageEcosystem, product = P) {
  const v = SHAPES[eco].v;
  await publishRow(eco, v.stable0, "stable", { product });
  await publishRow(eco, v.oldMain, "main", { product });
  await publishRow(eco, v.main1, "main", { product });
  await publishRow(eco, v.main2, "main", { product });
  await publishRow(eco, v.beta, "beta", { product });
  await publishRow(eco, v.newerMain, "main", { product });
}

const versionsOf = async (eco: PackageEcosystem, product = P) =>
  (
    await db.all<{ version: string }>(
      "SELECT version FROM release_packages WHERE product = ? AND deliverable_id = ? ORDER BY version",
      product,
      did(eco),
    )
  ).map((r) => r.version);

/** Render one package through its adapter, from the catalog (what the feeds serve). */
async function rendered(eco: PackageEcosystem): Promise<string> {
  const source = catalogPackageSource(packageCatalog({ db, slug: P }), P);
  const pkg = await source.package(P, did(eco));
  const adapter = FEED_ADAPTERS.find((a) => a.ecosystem === eco)!;
  const objects: readonly RenderedObject[] = await adapter.renderer.render(
    pkg!,
    {
      origin: "https://pkg.example.test",
      feed: { namespace: { publisher: "acme", scope: "@acme" }, ext: {} },
    },
  );
  return objects
    .map(
      (o) =>
        `${o.key}\n${typeof o.body === "string" ? o.body : new TextDecoder().decode(o.body)}`,
    )
    .join("\n");
}

/**
 * The retention switch through `writeSetting()` (ST-04), answering as the route does: `locked` for
 * the system product, `stale` for a version that is not the one read, else `written`.
 */
async function setRetention(
  product: string,
  enabled: boolean,
  expectedVersion: number,
  by = "admin:u1",
): Promise<string> {
  if (retentionLocked(product)) return "locked";
  const res = await writeSetting(
    { env: {}, db, registry: SETTINGS },
    { key: PRUNE_SETTING_KEY, value: enabled, expectedVersion },
    {
      actor: { sub: by, name: null, email: null },
      origin: "console",
      now: NOW,
      product,
      strict: false,
    },
  );
  return res.ok ? "written" : res.reason === "version_conflict" ? "stale" : res.reason;
}

/** Feed retention is off by default for a tenant product: opt `product` in. */
async function optIn(product = P): Promise<void> {
  expect(await setRetention(product, true, 0)).toBe("written");
}

/** The automatic prune after `version` of `eco`'s package was published on `channel`. */
const autoPrune = (
  eco: PackageEcosystem,
  version: string,
  channel = "stable",
  product = P,
  on: Db = db,
) =>
  pruneAfterStablePublish(
    on,
    env,
    product,
    {
      deliverableId: did(eco),
      ecosystem: eco,
      name: SHAPES[eco].name,
      version,
      channel,
    },
    NOW,
  );

beforeEach(async () => {
  db = makeTestDb();
  env = makeEnv(new KvMock(), [P]);
  seq = 0;
  await seedProduct(db, P);
});

// ── Versions ─────────────────────────────────────────────────────────────────────────────────

describe("which versions a stable release prunes", () => {
  it("reads final releases and builds of main per ecosystem", () => {
    expect(finalRelease("npm", "1.4.0")).toEqual([1, 4, 0]);
    expect(finalRelease("go", "v1.4.0")).toEqual([1, 4, 0]);
    expect(finalRelease("npm", "1.4.0-rc.1")).toBeNull();
    expect(finalRelease("pypi", "1.4.0rc1")).toBeNull();
    expect(finalRelease("pypi", "1.4.0.dev3")).toBeNull();
    expect(mainPrerelease("npm", "1.4.0-main.12")).toEqual([1, 4, 0]);
    expect(mainPrerelease("pypi", "1.4.0.dev12")).toEqual([1, 4, 0]);
    expect(mainPrerelease("npm", "1.4.0-rc.1")).toBeNull();
    expect(mainPrerelease("npm", "1.4.0.dev1")).toBeNull();
    expect(mainPrerelease("pypi", "1.4.0-main.1")).toBeNull();
    expect(mainPrerelease("npm", "1.4.0")).toBeNull();
    expect(compareRelease([1, 4], [1, 4, 0])).toBe(0);
    expect(compareRelease([1, 10, 0], [1, 9, 9])).toBe(1);
  });

  it("only a final release on stable triggers; a beta never does", () => {
    expect(triggersPrune("npm", "1.4.0", "stable")).toBe(true);
    expect(triggersPrune("npm", "1.4.0-rc.1", "beta")).toBe(false);
    expect(triggersPrune("npm", "1.4.0-rc.1", "stable")).toBe(false);
    expect(triggersPrune("npm", "1.4.0", "beta")).toBe(false);
    expect(triggersPrune("npm", "1.4.0-main.3", "main")).toBe(false);
    expect(triggersPrune("pypi", "1.4.0", null)).toBe(false);
  });
});

// ── Per ecosystem ────────────────────────────────────────────────────────────────────────────

describe.each(ECOS)("a stable publish on the %s feed", (eco) => {
  const v = SHAPES[eco].v;

  it("prunes the builds of main at or below it and nothing else; the feed's metadata drops them", async () => {
    await declare(P, [eco]);
    await optIn();
    await history(eco);
    await publishRow(eco, v.stable, "stable");
    const before = await rendered(eco);
    expect(before).toContain(v.main1);

    const out = await pruneAfterStablePublish(
      db,
      env,
      P,
      {
        deliverableId: did(eco),
        ecosystem: eco,
        name: SHAPES[eco].name,
        version: v.stable,
        channel: "stable",
      },
      NOW,
    );
    expect(out.status).toBe("pruned");
    expect(await versionsOf(eco)).toEqual(
      [v.stable0, v.beta, v.newerMain, v.stable].sort(),
    );
    const after = await rendered(eco);
    for (const gone of [v.main1, v.main2, v.oldMain])
      expect(after, `${eco} still renders ${gone}`).not.toContain(gone);
    for (const kept of [v.stable0, v.stable])
      expect(after, `${eco} lost ${kept}`).toContain(kept);
    // A render is queued for the package.
    expect(
      await db.first(
        "SELECT reason FROM registry_render_queue WHERE product = ? AND deliverable_id = ?",
        P,
        did(eco),
      ),
    ).toEqual({ reason: "prune" });
    // Each deletion's audit row links the stable release that triggered it.
    expect(
      await db.all(
        "SELECT DISTINCT parent_id FROM audit WHERE product = ? AND action = 'package.version.prune'",
        P,
      ),
    ).toEqual([{ parent_id: `${did(eco)}@${v.stable}` }]);
  });
});

describe("the npm dist-tags after a prune", () => {
  it("drops the main tag when every build of main went, and moves it to a remaining one otherwise", async () => {
    await declare(P, ["npm"]);
    // `main` is a manual channel, as the root .pkey/release declares it.
    await db.run(
      "INSERT INTO release_config (product, manual_channels_json) VALUES (?, ?)",
      P,
      JSON.stringify([
        { name: "main", regex: "v?[0-9]+\\.[0-9]+\\.[0-9]+-main\\.[0-9]+" },
      ]),
    );
    await publishRow("npm", "1.0.0", "stable");
    await publishRow("npm", "1.1.0-main.1", "main");
    await publishRow("npm", "1.1.0", "stable");
    const source = catalogPackageSource(packageCatalog({ db, slug: P }), P);
    const tags = async () => (await source.package(P, "npm.sdk"))!.tags;
    expect((await tags()).main).toBe("1.1.0-main.1");
    await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    });
    // No build of main is left: the tag never names a pruned version.
    const t = await tags();
    expect(t.main).toBeUndefined();
    expect(await rendered("npm")).not.toContain('"main":');
    expect(t.latest).toBe("1.1.0");

    // A newer build of main survives a later prune and keeps the tag.
    await publishRow("npm", "1.2.0-main.1", "main");
    await publishRow("npm", "1.1.1", "stable");
    await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    });
    expect((await tags()).main).toBe("1.2.0-main.1");
    expect(await rendered("npm")).toContain('"main":"1.2.0-main.1"');
  });
});

// ── Refcount, idempotency, dry run ───────────────────────────────────────────────────────────

describe("the shared-blob refcount", () => {
  it("frees a blob only when no remaining ref of any product holds it, and counts a shared one once", async () => {
    await declare(P, ["npm"]);
    await publishRow("npm", "1.0.0", "stable");
    // Two pruned builds share one blob (freed once); a third shares with a KEPT newer build.
    await publishRow("npm", "1.1.0-main.1", "main", {
      shared: "twin",
      size: 700,
    });
    await publishRow("npm", "1.1.0-main.2", "main", {
      shared: "twin",
      size: 700,
    });
    await publishRow("npm", "1.1.0-main.3", "main", {
      shared: "kept",
      size: 500,
    });
    await publishRow("npm", "1.2.0-main.1", "main", {
      shared: "kept",
      size: 500,
    });
    // A fourth shares with another product's file.
    await seedProduct(db, "other");
    await publishRow("npm", "1.1.0-main.4", "main", {
      shared: "cross",
      size: 300,
    });
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('other', ?, 'artifact', 'x/y', ?)`,
      `blobs/sha256/${hex("cross")}`,
      NOW,
    );
    await publishRow("npm", "1.1.0", "stable");

    const plan = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    expect(plan.prune.map((p) => p.version)).toEqual([
      "1.1.0-main.1",
      "1.1.0-main.2",
      "1.1.0-main.3",
      "1.1.0-main.4",
    ]);
    expect(plan.bytes).toBe(700 + 700 + 500 + 300);
    expect(plan.freedBytes).toBe(700);
    expect(plan.prune.map((p) => p.freedBytes)).toEqual([700, 0, 0, 0]);

    await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    });
    const refs = async (seed: string) =>
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM blob_refs WHERE storage_key = ?",
        `blobs/sha256/${hex(seed)}`,
      ))!.n;
    expect(await refs("twin")).toBe(0); // the collector reclaims it
    expect(await refs("kept")).toBe(1); // 1.2.0-main.1 still holds it
    expect(await refs("cross")).toBe(1); // the other product's ref
    // The objects themselves are never deleted here (the collector's job).
    expect(
      await db.first(
        "SELECT size FROM blob_objects WHERE storage_key = ?",
        `blobs/sha256/${hex("twin")}`,
      ),
    ).not.toBeNull();
  });
});

describe("applying a prune", () => {
  beforeEach(async () => {
    await declare(P, ["npm", "pypi"]);
    await optIn();
    await history("npm");
    await history("pypi");
    await publishRow("npm", "1.1.0", "stable");
    await publishRow("pypi", "1.1.0", "stable");
  });

  it("a dry run writes nothing and reports counts and bytes; apply deletes, tombstones and audits each version", async () => {
    const dry = (await prunePackages(db, env, P, {
      apply: false,
      actor: { sub: "ci:static:tok_1", name: "CI" },
      now: NOW,
    }))!;
    expect(dry.dryRun).toBe(true);
    expect(dry.totals).toEqual({
      versions: 6,
      bytes: 6000,
      freedBytes: 6000,
      failed: 0,
      skipped: 0,
    });
    expect(await versionsOf("npm")).toHaveLength(7);
    expect(
      await db.first("SELECT COUNT(*) AS n FROM release_package_prunes"),
    ).toEqual({ n: 0 });

    const applied = (await prunePackages(db, env, P, {
      apply: true,
      actor: { sub: "ci:static:tok_1", name: "CI" },
      now: NOW,
    }))!;
    expect(applied.dryRun).toBe(false);
    expect(applied.totals.versions).toBe(6);
    expect(await versionsOf("npm")).toEqual(
      ["1.0.0", "1.1.0", "1.1.0-rc.1", "1.1.1-main.1"].sort(),
    );
    for (const table of ["release_metadata", "release_artifacts"])
      expect(
        await db.first(
          `SELECT COUNT(*) AS n FROM ${table} WHERE product = ? AND release_id = ?`,
          P,
          "npm.sdk@1.1.0-main.1",
        ),
      ).toEqual({ n: 0 });
    expect(
      await db.first(
        "SELECT stable, files, bytes, freed_bytes, pruned_by FROM release_package_prunes WHERE version = ?",
        "1.1.0-main.1",
      ),
    ).toEqual({
      stable: "1.1.0",
      files: 1,
      bytes: 1000,
      freed_bytes: 1000,
      pruned_by: "ci:static:tok_1",
    });
    const audit = await db.all<{
      actor_sub: string;
      target_id: string;
      parent_id: string;
      summary: string;
    }>(
      "SELECT actor_sub, target_id, parent_id, summary FROM audit WHERE product = ? AND action = 'package.version.prune' ORDER BY target_id",
      P,
    );
    expect(audit).toHaveLength(6);
    expect(audit[0]).toMatchObject({
      actor_sub: "ci:static:tok_1",
      target_id: "npm:@acme/sdk@1.0.0-main.9",
      // The backfill links its ceiling: the package's newest live stable release.
      parent_id: "npm.sdk@1.1.0",
    });
    expect(audit.find((a) => a.target_id.startsWith("pypi:"))!.parent_id).toBe(
      "pypi.sdk@1.1.0",
    );
    expect(audit[0]!.summary).toContain("1000 bytes");
  });

  it("is idempotent: a second run prunes nothing and audits nothing more", async () => {
    const run = () =>
      prunePackages(db, env, P, {
        apply: true,
        actor: SYSTEM_PRUNE_ACTOR,
        now: NOW,
      });
    expect((await run())!.totals.versions).toBe(6);
    const second = (await run())!;
    expect(second.totals.versions).toBe(0);
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM audit WHERE action = 'package.version.prune'",
      ),
    ).toEqual({ n: 6 });
    // The automatic prune after the same stable is a no-op too.
    const auto = await pruneAfterStablePublish(
      db,
      env,
      P,
      {
        deliverableId: "npm.sdk",
        ecosystem: "npm",
        name: "@acme/sdk",
        version: "1.1.0",
        channel: "stable",
      },
      NOW,
    );
    expect(auto.status === "pruned" && auto.applied.pruned).toEqual([]);
  });

  it("keeps a build of main a channel points at", async () => {
    const pin = stmtSetChannelPolicy(
      { product: P, deliverableId: "npm.sdk", channel: "nightly" },
      { pointerReleaseId: "npm.sdk@1.1.0-main.2", pinned: true },
      { source: "admin", by: "admin:u1", now: NOW },
    );
    await db.run(pin.sql, ...pin.params);
    const plan = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    expect(plan.kept).toEqual([
      {
        releaseId: "npm.sdk@1.1.0-main.2",
        version: "1.1.0-main.2",
        reason: "pinned",
      },
    ]);
    expect(plan.prune.map((p) => p.version)).toEqual([
      "1.0.0-main.9",
      "1.1.0-main.1",
    ]);
  });

  it("deletes at most the run's budget and leaves the rest for the next run", async () => {
    const plan = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    expect(plan.prune).toHaveLength(3);
    const first = await applyPackagePrune(
      db,
      env,
      P,
      plan,
      SYSTEM_PRUNE_ACTOR,
      NOW,
      2,
    );
    expect(first.pruned).toHaveLength(2);
    const rest = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    expect(rest.prune.map((v) => v.version)).toEqual(["1.1.0-main.2"]);
  });

  it("only the named package with a deliverable", async () => {
    const r = (await prunePackages(db, env, P, {
      apply: true,
      deliverable: "pypi.sdk",
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(r.packages.map((p) => p.deliverableId)).toEqual(["pypi.sdk"]);
    expect(await versionsOf("npm")).toHaveLength(7);
    expect(
      await prunePackages(db, env, P, {
        apply: false,
        deliverable: "nope",
        actor: SYSTEM_PRUNE_ACTOR,
        now: NOW,
      }),
    ).toBeNull();
  });
});

// ── The trigger ──────────────────────────────────────────────────────────────────────────────

describe("the automatic prune", () => {
  beforeEach(async () => {
    await declare(P, ["npm"]);
    await history("npm");
  });

  it("a beta publish prunes nothing", async () => {
    await optIn();
    await publishRow("npm", "1.1.0-rc.2", "beta");
    const out = await pruneAfterStablePublish(
      db,
      env,
      P,
      {
        deliverableId: "npm.sdk",
        ecosystem: "npm",
        name: "@acme/sdk",
        version: "1.1.0-rc.2",
        channel: "beta",
      },
      NOW,
    );
    expect(out).toEqual({ status: "not-stable" });
    expect(await versionsOf("npm")).toHaveLength(7);
  });

  it("is off by default for a tenant product: a stable publish prunes nothing until it opts in", async () => {
    expect(await pruneRetentionOf(db, P)).toEqual({
      prunePrereleases: false,
      locked: false,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
    await publishRow("npm", "1.1.0", "stable");
    expect(await autoPrune("npm", "1.1.0")).toEqual({ status: "off" });
    expect(await versionsOf("npm")).toHaveLength(7);
    expect(
      await db.first("SELECT COUNT(*) AS n FROM release_package_prunes"),
    ).toEqual({ n: 0 });

    // Opting in (version 0 → 1), then turning it off again, each against the version read.
    await optIn();
    expect(await setRetention(P, false, 0)).toBe(
      "stale",
    );
    expect(await pruneRetentionOf(db, P)).toMatchObject({
      prunePrereleases: true,
      locked: false,
      version: 1,
      updatedBy: "admin:u1",
    });
    expect(await setRetention(P, false, 1)).toBe(
      "written",
    );
    expect(await autoPrune("npm", "1.1.0")).toEqual({ status: "off" });
    expect(await versionsOf("npm")).toHaveLength(7);
  });

  it("is on by default for the system product, which cannot turn it off", async () => {
    expect(await pruneRetentionOf(db, SYSTEM_PRODUCT_SLUG)).toEqual({
      prunePrereleases: true,
      locked: true,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    });
    expect(
      await setRetention(SYSTEM_PRODUCT_SLUG, false, 0, "u"),
    ).toBe("locked");
    // Even a row that says off (written around the API) does not turn it off.
    await seedProduct(db, SYSTEM_PRODUCT_SLUG);
    await db.run(
      "INSERT INTO release_package_retention (product, prune_prereleases, version, updated_at) VALUES (?, 0, 1, ?)",
      SYSTEM_PRODUCT_SLUG,
      NOW,
    );
    expect(
      (await pruneRetentionOf(db, SYSTEM_PRODUCT_SLUG)).prunePrereleases,
    ).toBe(true);
  });

  it("registers the setting with the tenant default, off", () => {
    const def = SETTINGS.get("release.packages.prunePrereleases", "product")!;
    expect(def.defaultValue).toBe(false);
    expect(def.storage).toEqual({
      kind: "column",
      table: "release_package_retention",
      column: "prune_prereleases",
    });
  });

  it("never throws: a failing prune is audited, and the next run retries it", async () => {
    await optIn();
    await publishRow("npm", "1.1.0", "stable");
    const failing: Db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch")
          return async () => {
            throw new Error("D1 is down");
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const out = await pruneAfterStablePublish(
      failing,
      env,
      P,
      {
        deliverableId: "npm.sdk",
        ecosystem: "npm",
        name: "@acme/sdk",
        version: "1.1.0",
        channel: "stable",
      },
      NOW,
    );
    expect(out.status).toBe("pruned");
    if (out.status === "pruned") expect(out.applied.failed).toHaveLength(3);
    expect(await versionsOf("npm")).toHaveLength(7);
    const failed = await db.all<{ target_id: string }>(
      "SELECT target_id FROM audit WHERE action = 'package.prune.failed' ORDER BY target_id",
    );
    expect(failed.map((r) => r.target_id)).toEqual([
      "npm:@acme/sdk@1.0.0-main.9",
      "npm:@acme/sdk@1.1.0-main.1",
      "npm:@acme/sdk@1.1.0-main.2",
    ]);

    // A read that throws fails the whole plan: still no throw, still audited.
    const broken: Db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "all")
          return async () => {
            throw new Error("no such table");
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const out2 = await pruneAfterStablePublish(
      broken,
      env,
      P,
      {
        deliverableId: "npm.sdk",
        ecosystem: "npm",
        name: "@acme/sdk",
        version: "1.1.0",
        channel: "stable",
      },
      NOW,
    );
    expect(out2).toEqual({ status: "failed", error: "no such table" });

    // The retry (the next stable publish, or the backfill) completes it.
    const retry = await pruneAfterStablePublish(
      db,
      env,
      P,
      {
        deliverableId: "npm.sdk",
        ecosystem: "npm",
        name: "@acme/sdk",
        version: "1.1.0",
        channel: "stable",
      },
      NOW,
    );
    expect(retry.status === "pruned" && retry.applied.pruned.length).toBe(3);
  });
});

// ── Render leftovers ─────────────────────────────────────────────────────────────────────────

describe("the render after a prune", () => {
  it("deletes the per-version documents of pruned versions from the registry prefix", async () => {
    await declare(P, ["go"]);
    await publishRow("go", "1.0.0", "stable");
    await publishRow("go", "1.1.0-main.1", "main");
    await publishRow("go", "1.1.0", "stable");
    const r2 = new R2Mock();
    const deps = {
      bucket: asR2(r2),
      renderers: RENDERERS,
      source: catalogPackageSource(packageCatalog({ db, slug: P }), P),
      origin: "https://pkg.example.test",
    };
    const first = await materialise(deps, P, "go.sdk");
    expect(first.status).toBe("rendered");
    const pruned = (first.status === "rendered" ? first.keys : []).filter((k) =>
      k.includes("1.1.0-main.1"),
    );
    expect(pruned.length).toBeGreaterThan(0);
    await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    });
    await materialise(deps, P, "go.sdk");
    for (const k of pruned) expect(await r2.head(k), k).toBeNull();
    expect(await r2.head(renderRecordKey("go", P, "go.sdk"))).not.toBeNull();
  });
});

// ── Safety points (review of feed-prune, 2026-10-06) ─────────────────────────────────────────

describe("the channel filter", () => {
  it("a build of main published on beta, nightly or stable is never a candidate", async () => {
    await declare(P, ["npm", "pypi"]);
    await optIn();
    const spellings = {
      npm: ["1.1.0-main.1", "1.1.0-main.2", "1.1.0-main.3", "1.1.0-main.4"],
      pypi: ["1.1.0.dev1", "1.1.0.dev2", "1.1.0.dev3", "1.1.0.dev4"],
    } as const;
    for (const eco of ["npm", "pypi"] as const) {
      const [onBeta, onNightly, onStable, onMain] = spellings[eco];
      await publishRow(eco, "1.0.0", "stable");
      await publishRow(eco, onBeta, "beta");
      await publishRow(eco, onNightly, "nightly");
      await publishRow(eco, onStable, "stable");
      await publishRow(eco, onMain, "main");
      await publishRow(eco, "1.1.0", "stable");
      // Every one of them is spelled as a build of main: only the channel tells them apart.
      for (const v of spellings[eco])
        expect(mainPrerelease(eco, v), v).toEqual([1, 1, 0]);

      const plan = (await planPackagePrune(db, P, did(eco), "1.1.0"))!;
      expect(plan.prune.map((p) => p.version)).toEqual([onMain]);
      expect(plan.kept).toEqual([]);
      await autoPrune(eco, "1.1.0");
      expect(await versionsOf(eco)).toEqual(
        ["1.0.0", "1.1.0", onBeta, onNightly, onStable].sort(),
      );
    }
  });
});

describe("another product", () => {
  it("with the same deliverable id and versions is untouched by the automatic prune and the backfill", async () => {
    const O = "other";
    await seedProduct(db, O);
    await declare(P, ["npm"]);
    await declare(O, ["npm"]);
    await optIn(P);
    await optIn(O);
    await history("npm", P);
    await history("npm", O);
    await publishRow("npm", "1.1.0", "stable", { product: P });
    await publishRow("npm", "1.1.0", "stable", { product: O });

    const snapshot = async () => ({
      versions: await versionsOf("npm", O),
      ...Object.fromEntries(
        await Promise.all(
          [
            "release_metadata",
            "release_artifacts",
            "release_packages",
            "blob_refs",
            "release_package_prunes",
          ].map(
            async (t) =>
              [
                t,
                (await db.first<{ n: number }>(
                  `SELECT COUNT(*) AS n FROM ${t} WHERE product = ?`,
                  O,
                ))!.n,
              ] as const,
          ),
        ),
      ),
    });
    const before = await snapshot();
    expect(before.versions).toHaveLength(7);

    expect((await autoPrune("npm", "1.1.0")).status).toBe("pruned");
    const backfill = (await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(backfill.packages.map((p) => p.deliverableId)).toEqual(["npm.sdk"]);
    expect(await versionsOf("npm", P)).toHaveLength(4);
    expect(await snapshot()).toEqual(before);
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM audit WHERE product = ? AND action = 'package.version.prune'",
        O,
      ),
    ).toEqual({ n: 0 });
    // The two products hold the same content-addressed blobs, so P's prune freed nothing.
    expect(
      await db.all(
        "SELECT DISTINCT freed_bytes FROM release_package_prunes WHERE product = ?",
        P,
      ),
    ).toEqual([{ freed_bytes: 0 }]);
  });
});

describe("odd version spellings", () => {
  const FULLWIDTH_ONE = "１";
  it.each([
    ["npm", "1.1.0-main.1+b"],
    ["npm", "1.1.0-MAIN.1"],
    ["npm", "1.1.0-main.1.2"],
    ["npm", "1.1.0-main"],
    ["npm", "1.1.0-rc.1-main.1"],
    ["npm", "1.1.0-main.1\n"],
    ["npm", "1.1.0\n"],
    ["npm", `1.1.0-main.${FULLWIDTH_ONE}`],
    ["npm", `1.1.${FULLWIDTH_ONE}`],
    ["go", "v1.1.0-main.1+b"],
    ["pypi", "1!1.0.0.dev1"],
    ["pypi", "1.0.0.post1.dev1"],
    ["pypi", "1.0.0rc1.dev1"],
    ["pypi", "1.0.0-dev1"],
    ["pypi", "1.0.0dev1"],
    ["pypi", "1.0.0.dev1\n"],
    ["pypi", `1.0.0.dev${FULLWIDTH_ONE}`],
    ["pypi", `1.0.${FULLWIDTH_ONE}`],
  ])("%s %j is neither a build of main nor a final release", (eco, v) => {
    expect(mainPrerelease(eco, v)).toBeNull();
    expect(finalRelease(eco, v)).toBeNull();
  });
});

describe("a yanked stable", () => {
  it("is never the ceiling: a yanked 99.0.0 does not make current builds of main candidates", async () => {
    await declare(P, ["npm"]);
    await optIn();
    await publishRow("npm", "1.0.0", "stable");
    await publishRow("npm", "1.1.0-main.1", "main");
    await publishRow("npm", "1.1.0-main.2", "main");
    await publishRow("npm", "99.0.0", "stable");
    await db.batch([
      {
        sql: "UPDATE release_packages SET state = 'yanked', state_message = 'oops' WHERE product = ? AND release_id = ?",
        params: [P, "npm.sdk@99.0.0"],
      },
      {
        sql: "INSERT INTO release_yanks (product, release_id, reason, at, by) VALUES (?, ?, 'oops', ?, 'admin:u1')",
        params: [P, "npm.sdk@99.0.0", NOW],
      },
    ]);

    expect(await newestStable(db, P, "npm.sdk")).toBe("1.0.0");
    expect(await planPackagePrune(db, P, "npm.sdk", "99.0.0")).toBeNull();
    const r = (await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(r.packages[0]).toMatchObject({ stable: "1.0.0", prune: [] });
    expect(r.totals.versions).toBe(0);
    expect(await versionsOf("npm")).toEqual(
      ["1.0.0", "1.1.0-main.1", "1.1.0-main.2", "99.0.0"].sort(),
    );
  });
});

describe("the per-run cap", () => {
  it(`more than ${PRUNE_MAX_PER_RUN} candidates across packages: exactly ${PRUNE_MAX_PER_RUN} go, more is set, the next run takes the rest`, async () => {
    await declare(P, ["npm", "pypi"]);
    for (const eco of ["npm", "pypi"] as const) {
      await publishRow(eco, "1.0.0", "stable");
      for (let n = 1; n <= 110; n++)
        await publishRow(
          eco,
          eco === "npm" ? `1.0.0-main.${n}` : `1.0.0.dev${n}`,
          "main",
        );
    }
    const run = () =>
      prunePackages(db, env, P, {
        apply: true,
        actor: SYSTEM_PRUNE_ACTOR,
        now: NOW,
      });
    const tombstones = async () =>
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM release_package_prunes WHERE product = ?",
        P,
      ))!.n;

    const first = (await run())!;
    expect(first.more).toBe(true);
    expect(first.totals.versions).toBe(PRUNE_MAX_PER_RUN);
    expect(first.packages.map((p) => p.prune.length)).toEqual([110, 90]);
    expect(await tombstones()).toBe(PRUNE_MAX_PER_RUN);
    expect(
      (await versionsOf("npm")).length + (await versionsOf("pypi")).length,
    ).toBe(2 + 220 - PRUNE_MAX_PER_RUN);

    const second = (await run())!;
    expect(second.more).toBe(false);
    expect(second.totals.versions).toBe(220 - PRUNE_MAX_PER_RUN);
    expect(await tombstones()).toBe(220);
    expect(await versionsOf("pypi")).toEqual(["1.0.0"]);
  });

  it("records only the bytes this run's own deletions freed when the cap cuts it short", async () => {
    await declare(P, ["npm"]);
    await publishRow("npm", "1.0.0", "stable");
    // Two builds share one blob; the cap lets only the first go this run.
    await publishRow("npm", "1.1.0-main.1", "main", {
      shared: "pair",
      size: 700,
    });
    await publishRow("npm", "1.1.0-main.2", "main", {
      shared: "pair",
      size: 700,
    });
    await publishRow("npm", "1.1.0", "stable");
    const plan = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    // The plan counts against the WHOLE plan: the pair is freed, against the first.
    expect(plan.prune.map((v) => v.freedBytes)).toEqual([700, 0]);

    const first = await applyPackagePrune(
      db,
      env,
      P,
      plan,
      SYSTEM_PRUNE_ACTOR,
      NOW,
      1,
    );
    // 1.1.0-main.2 still holds the blob: nothing was freed by this run.
    expect(first.pruned).toMatchObject([
      { version: "1.1.0-main.1", bytes: 700, freedBytes: 0 },
    ]);
    const tomb = (v: string) =>
      db.first<{ freed_bytes: number }>(
        "SELECT freed_bytes FROM release_package_prunes WHERE product = ? AND version = ?",
        P,
        v,
      );
    expect(await tomb("1.1.0-main.1")).toEqual({ freed_bytes: 0 });
    const summary = await db.first<{ summary: string }>(
      "SELECT summary FROM audit WHERE action = 'package.version.prune' AND target_id = ?",
      "npm:@acme/sdk@1.1.0-main.1",
    );
    expect(summary!.summary).toContain(
      "700 bytes, 0 bytes no longer referenced",
    );

    // The next run deletes the last holder, and its row carries the freed bytes.
    const rest = (await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(rest.packages[0]!.prune).toMatchObject([
      { version: "1.1.0-main.2", freedBytes: 700 },
    ]);
    expect(rest.totals.freedBytes).toBe(700);
    expect(await tomb("1.1.0-main.2")).toEqual({ freed_bytes: 700 });
  });
});

describe("a partial failure", () => {
  it("commits the other batches, leaves the failed one whole, and the next run finishes it", async () => {
    await declare(P, ["npm"]);
    await publishRow("npm", "1.0.0", "stable");
    for (let n = 1; n <= 50; n++)
      await publishRow("npm", `1.0.0-main.${n}`, "main", {
        // main.1 (first batch) shares its blob with main.25 (the second, failing, batch).
        ...(n === 1 || n === 25 ? { shared: "split", size: 700 } : {}),
      });
    let batches = 0;
    const flaky: Db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "batch")
          return async (stmts: Parameters<Db["batch"]>[0]) => {
            if (++batches === 2) throw new Error("D1 hiccup");
            return target.batch(stmts);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const r = (await prunePackages(flaky, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    // Batches of 20: the first and third committed, the second failed as a whole.
    expect(batches).toBe(3);
    expect(r.totals).toMatchObject({ versions: 30, failed: 20, skipped: 0 });
    const failed = r.packages[0]!.failed!.map((f) => f.version);
    expect(failed).toHaveLength(20);
    expect(failed[0]).toBe("1.0.0-main.21");
    expect(new Set(r.packages[0]!.failed!.map((f) => f.error))).toEqual(
      new Set(["D1 hiccup"]),
    );
    // The failed batch's versions are whole: rows, files and blob refs.
    for (const v of failed) {
      const id = `npm.sdk@${v}`;
      for (const t of [
        "release_metadata",
        "release_artifacts",
        "release_packages",
      ])
        expect(
          await db.first(
            `SELECT COUNT(*) AS n FROM ${t} WHERE product = ? AND release_id = ?`,
            P,
            id,
          ),
          `${t} ${v}`,
        ).toEqual({ n: 1 });
      expect(
        await db.first(
          "SELECT COUNT(*) AS n FROM blob_refs WHERE product = ? AND ref_id LIKE ?",
          P,
          `${id}/%`,
        ),
      ).toEqual({ n: 1 });
    }
    // main.1 went while main.25 (failed) still holds the shared blob: it freed nothing.
    expect(
      await db.first(
        "SELECT freed_bytes FROM release_package_prunes WHERE version = '1.0.0-main.1'",
      ),
    ).toEqual({ freed_bytes: 0 });

    const next = (await prunePackages(db, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(next.totals).toMatchObject({ versions: 20, failed: 0 });
    expect(await versionsOf("npm")).toEqual(["1.0.0"]);
    expect(
      await db.first(
        "SELECT freed_bytes FROM release_package_prunes WHERE version = '1.0.0-main.25'",
      ),
    ).toEqual({ freed_bytes: 700 });
  });
});

describe("a version held between the plan and the deletion", () => {
  const pinMain2 = () =>
    stmtSetChannelPolicy(
      { product: P, deliverableId: "npm.sdk", channel: "nightly" },
      { pointerReleaseId: "npm.sdk@1.1.0-main.2", pinned: true },
      { source: "admin", by: "admin:u1", now: NOW },
    );

  beforeEach(async () => {
    await declare(P, ["npm"]);
    await history("npm");
    await publishRow("npm", "1.1.0", "stable");
  });

  it("is skipped and reported, never dropped silently", async () => {
    const plan = (await planPackagePrune(db, P, "npm.sdk", "1.1.0"))!;
    expect(plan.prune.map((v) => v.version)).toContain("1.1.0-main.2");
    const pin = pinMain2();
    await db.run(pin.sql, ...pin.params);
    const applied = await applyPackagePrune(
      db,
      env,
      P,
      plan,
      SYSTEM_PRUNE_ACTOR,
      NOW,
    );
    expect(applied.skipped).toEqual([
      {
        releaseId: "npm.sdk@1.1.0-main.2",
        version: "1.1.0-main.2",
        reason: "pinned",
      },
    ]);
    expect(applied.pruned.map((v) => v.version)).toEqual([
      "1.0.0-main.9",
      "1.1.0-main.1",
    ]);
    expect(await versionsOf("npm")).toContain("1.1.0-main.2");
  });

  it("shows in the backfill's report, per package and in the totals", async () => {
    // The pin lands between the backfill's plan and its apply (the second holds read).
    let holdsReads = 0;
    const racing: Db = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "all")
          return async (sql: string, ...params: Parameters<Db["all"]>[1][]) => {
            if (
              sql.includes("FROM release_channel_policy") &&
              ++holdsReads === 2
            ) {
              const pin = pinMain2();
              await target.run(pin.sql, ...pin.params);
            }
            return target.all(sql, ...params);
          };
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const r = (await prunePackages(racing, env, P, {
      apply: true,
      actor: SYSTEM_PRUNE_ACTOR,
      now: NOW,
    }))!;
    expect(r.packages[0]!.skipped).toEqual([
      {
        releaseId: "npm.sdk@1.1.0-main.2",
        version: "1.1.0-main.2",
        reason: "pinned",
      },
    ]);
    expect(r.totals).toMatchObject({ versions: 2, skipped: 1, failed: 0 });
    expect(JSON.parse(JSON.stringify(r)).packages[0].skipped).toHaveLength(1);
  });
});

describe("the blob collector after a prune", () => {
  it("stamps a blob only the pruned version held and leaves a shared one unstamped", async () => {
    await declare(P, ["npm"]);
    await optIn();
    await publishRow("npm", "1.0.0", "stable");
    await publishRow("npm", "1.1.0-main.1", "main", { shared: "solo" });
    await publishRow("npm", "1.1.0-main.2", "main", { shared: "both" });
    await publishRow("npm", "1.2.0-main.1", "main", { shared: "both" });
    await publishRow("npm", "1.1.0", "stable");
    const stamp = async (seed: string) =>
      (await db.first<{ unreferenced_since: number | null }>(
        "SELECT unreferenced_since FROM blob_objects WHERE storage_key = ?",
        `blobs/sha256/${hex(seed)}`,
      ))!.unreferenced_since;

    await markUnreferenced(db, NOW + 1);
    expect(await stamp("solo")).toBeNull();
    expect(await stamp("both")).toBeNull();

    expect((await autoPrune("npm", "1.1.0")).status).toBe("pruned");
    expect(await versionsOf("npm")).toEqual(
      ["1.0.0", "1.1.0", "1.2.0-main.1"].sort(),
    );
    await markUnreferenced(db, NOW + 2);
    expect(await stamp("solo")).toBe(NOW + 2);
    expect(await stamp("both")).toBeNull();
  });
});
