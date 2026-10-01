/**
 * P2-03 — the release data model v2: deliverables, builds, artifact roles, channel policy, yanks.
 *
 *   1. The 0027 migrations, applied to a database holding TODAY's shapes (seeded between 0026 and
 *      0027 exactly as the GitHub sync wrote them), backfill what every later package reads:
 *      one `app` deliverable, `deliverable_id = 'app'`, a gap-free `seq` in publish order, and a
 *      `role` from the legacy kind. They replay cleanly (0012/0018 conventions).
 *   2. `seq` is unique per deliverable, not per product.
 *   3. `model.ts`: the writers validate against @polaris-key/manifest's vocabularies, and the
 *      channel policy is source-guarded exactly like `services_source`.
 */

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/sqlite.js";
import {
  getChannelPolicy,
  getDeliverable,
  isYanked,
  listArtifactsForBuild,
  listBuilds,
  listChannelPolicies,
  listDeliverables,
  listYanks,
  nextSeq,
  ReleaseModelError,
  revertChannelPolicyToManifest,
  roleOfKind,
  setChannelPolicy,
  stmtSetArtifactModel,
  stmtUpsertBuild,
  stmtUpsertDeliverable,
  unyankRelease,
  upsertBuild,
  upsertDeliverable,
  yankRelease,
} from "../src/services/release/model.js";
import { makeTestDb } from "./helpers.js";
import { NOW, seedProduct } from "./seed.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, "..", "migrations");
const FILES = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const BEFORE = FILES.filter((f) => f < "0027");
const P2_03 = FILES.filter((f) => f.startsWith("0027_"));
/** The files that must replay cleanly: everything but the single-statement column additions. */
const IDEMPOTENT = P2_03.filter((f) => !/^0027_[b-g]_/.test(f));

const SLUG = "djdl";

function sql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

function databaseAt(files: string[]): {
  raw: Database.Database;
  db: SqliteDb;
} {
  const raw = new Database(":memory:");
  const run = raw.exec.bind(raw);
  for (const f of files) run(sql(f));
  return { raw, db: new SqliteDb(raw) };
}

function apply(raw: Database.Database, files: string[]): void {
  const run = raw.exec.bind(raw);
  for (const f of files) run(sql(f));
}

/** Today's shapes, as the pre-P2-03 sync wrote them: no deliverable, no seq, no role. */
async function seedLegacyStore(db: SqliteDb): Promise<void> {
  await seedProduct(db, SLUG);
  await db.run(
    `INSERT INTO release_config (product, gh_owner, gh_repo, gh_installation_id, beta_branch,
       binary_name, summary_marker)
     VALUES (?, 'acme', 'djdl', 42, 'main', 'djdl', 'pkey:summary')`,
    SLUG,
  );
  // Inserted in an order that is neither publish order nor version order, so the backfill has
  // to sort rather than inherit rowid order.
  const releases: [string, string, number, boolean][] = [
    ["v1.1.0", "1.1.0", NOW + 200, false],
    ["v2.0.0-beta.1", "2.0.0-beta.1", NOW + 300, true],
    ["v1.0.0", "1.0.0", NOW + 100, false],
  ];
  for (const [tag, version, at, prerelease] of releases) {
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, title, notes, commit_sha, source_url, metadata_access,
          artifacts_access, published_at, metadata_json, created_at, modified_at)
       VALUES (?,?,?,?,NULL,NULL,?, 'public','public',?,?,?,?)`,
      SLUG,
      tag,
      version,
      version,
      `https://github.com/acme/djdl/releases/tag/${tag}`,
      at,
      JSON.stringify({ tag, prerelease, assetCount: 3 }),
      NOW,
      NOW,
    );
  }
  const artifacts: [string, string, string, string][] = [
    ["v1.0.0", "1", "djdl-1.0.0-arm64.dmg", "dmg"],
    ["v1.0.0", "2", "djdl-1.0.0-arm64.dmg.sig", "signature"],
    ["v1.0.0", "3", "djdl-1.0.0-arm64.dmg.sha256", "checksum"],
    ["v1.1.0", "4", "djdl-1.1.0-arm64.dmg", "dmg"],
    ["v1.1.0", "5", "djdl-arm64", "cli"],
    ["v2.0.0-beta.1", "6", "notes.txt", "other"],
  ];
  for (const [releaseId, id, name, kind] of artifacts) {
    await db.run(
      `INSERT INTO release_artifacts
         (product, release_id, artifact_id, name, kind, platform, arch, content_type, size_bytes,
          sha256, source_url, storage_key, sparkle_signature, access, metadata_json, created_at)
       VALUES (?,?,?,?,?,'macos','arm64','application/octet-stream',1,NULL,?,NULL,NULL,
               'public',NULL,?)`,
      SLUG,
      releaseId,
      id,
      name,
      kind,
      `https://github.com/acme/djdl/releases/download/${releaseId}/${name}`,
      NOW,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The migrations
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("0027 migrations", () => {
  it("are the lettered 0027 set, with the column additions one statement per file", () => {
    expect(P2_03.map((f) => f.slice(0, 6))).toEqual([
      "0027_a",
      "0027_b",
      "0027_c",
      "0027_d",
      "0027_e",
      "0027_f",
      "0027_g",
      "0027_h",
      "0027_i",
    ]);
    for (const f of P2_03.filter((f) => /^0027_[b-g]_/.test(f))) {
      const statements = sql(f)
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      expect(statements, f).toHaveLength(1);
      expect(statements[0], f).toMatch(/^ALTER TABLE \w+ ADD COLUMN \w+/);
    }
  });

  it("apply on a fresh database", async () => {
    const db = makeTestDb();
    const tables = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'release_%'",
      )
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "release_deliverables",
        "release_builds",
        "release_channel_policy",
        "release_yanks",
      ]),
    );
    const indexes = (
      await db.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_release_%'",
      )
    ).map((i) => i.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_release_metadata_version",
        "idx_release_metadata_seq",
        "idx_release_builds_target",
        "idx_release_artifacts_sha256",
      ]),
    );
  });

  it("backfill a database seeded with today's shapes", async () => {
    const { raw, db } = databaseAt(BEFORE);
    await seedLegacyStore(db);
    apply(raw, P2_03);

    expect(
      (await listDeliverables(db, SLUG)).map((d) => [
        d.deliverable_id,
        d.kind,
        d.def_source,
      ]),
    ).toEqual([["app", "app", "manifest"]]);

    const releases = await db.all<{
      release_id: string;
      deliverable_id: string;
      seq: number;
      channel: string | null;
    }>(
      "SELECT release_id, deliverable_id, seq, channel FROM release_metadata ORDER BY seq",
    );
    // Gap-free, from 1, in PUBLISH order (not insertion order, not version order).
    expect(releases).toEqual([
      { release_id: "v1.0.0", deliverable_id: "app", seq: 1, channel: null },
      { release_id: "v1.1.0", deliverable_id: "app", seq: 2, channel: null },
      {
        release_id: "v2.0.0-beta.1",
        deliverable_id: "app",
        seq: 3,
        channel: null,
      },
    ]);

    const roles = Object.fromEntries(
      (
        await db.all<{ name: string; role: string; build_id: null }>(
          "SELECT name, role, build_id FROM release_artifacts",
        )
      ).map((a) => [a.name, a.role]),
    );
    expect(roles).toEqual({
      "djdl-1.0.0-arm64.dmg": "payload",
      "djdl-1.0.0-arm64.dmg.sig": "signature",
      "djdl-1.0.0-arm64.dmg.sha256": "checksum",
      "djdl-1.1.0-arm64.dmg": "payload",
      "djdl-arm64": "payload",
      "notes.txt": "payload",
    });
    // The backfill's rule and the sync's are one rule.
    expect(
      ["dmg", "signature", "checksum", "cli", null].map(roleOfKind),
    ).toEqual(["payload", "signature", "checksum", "payload", "payload"]);

    const assertion = await db.first<{ expected: number; found: number }>(
      "SELECT expected, found FROM schema_index_assertion",
    );
    expect(assertion?.found).toBe(assertion?.expected);
  });

  it("replay: every idempotent file re-runs to the same end state", async () => {
    const { raw, db } = databaseAt(BEFORE);
    await seedLegacyStore(db);
    apply(raw, P2_03);
    const snapshot = async () => ({
      deliverables: await db.all("SELECT * FROM release_deliverables"),
      metadata: await db.all(
        "SELECT release_id, seq, deliverable_id FROM release_metadata ORDER BY release_id",
      ),
      roles: await db.all(
        "SELECT artifact_id, role FROM release_artifacts ORDER BY artifact_id",
      ),
    });
    const before = await snapshot();
    apply(raw, IDEMPOTENT);
    expect(await snapshot()).toEqual(before);
  });

  it("replay after rows the old code wrote mid-deploy continues the sequence without a gap", async () => {
    const { raw, db } = databaseAt(BEFORE);
    await seedLegacyStore(db);
    apply(raw, P2_03);
    // A row written between the column additions and the backfill: no seq yet.
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, published_at,
          created_at, modified_at)
       VALUES (?, 'v1.2.0', '1.2.0', 'public', 'public', ?, ?, ?)`,
      SLUG,
      NOW + 50,
      NOW,
      NOW,
    );
    apply(raw, IDEMPOTENT);
    const seqs = await db.all<{ release_id: string; seq: number }>(
      "SELECT release_id, seq FROM release_metadata ORDER BY seq",
    );
    expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(seqs.at(-1)!.release_id).toBe("v1.2.0");
  });

  it("widen idx_release_metadata_version to the deliverable and keep it non-unique", async () => {
    const db = makeTestDb();
    const cols = await db.all<{ name: string }>(
      "PRAGMA index_info(idx_release_metadata_version)",
    );
    expect(cols.map((c) => c.name)).toEqual([
      "product",
      "deliverable_id",
      "version",
    ]);
    const list = await db.all<{ name: string; unique: number }>(
      "PRAGMA index_list(release_metadata)",
    );
    expect(
      list.find((i) => i.name === "idx_release_metadata_version")?.unique,
    ).toBe(0);
    expect(
      list.find((i) => i.name === "idx_release_metadata_seq")?.unique,
    ).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// seq
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("seq", () => {
  async function insertRelease(
    db: SqliteDb,
    releaseId: string,
    deliverable: string,
    seq: number,
  ): Promise<void> {
    await db.run(
      `INSERT INTO release_metadata
         (product, release_id, version, metadata_access, artifacts_access, created_at,
          modified_at, deliverable_id, seq)
       VALUES (?, ?, '1.0.0', 'public', 'public', ?, ?, ?, ?)`,
      SLUG,
      releaseId,
      NOW,
      NOW,
      deliverable,
      seq,
    );
  }

  it("two releases of one deliverable cannot share a seq; two deliverables can", async () => {
    const db = makeTestDb();
    await seedProduct(db, SLUG);
    await insertRelease(db, "v1.0.0", "app", 1);
    await expect(insertRelease(db, "1.0.0", "app", 1)).rejects.toThrow(
      /UNIQUE constraint failed/,
    );
    await insertRelease(db, "dice.core@1.0.0", "dice.core", 1);
    expect(await nextSeq(db, SLUG, "app")).toBe(2);
    expect(await nextSeq(db, SLUG, "dice.core")).toBe(2);
    expect(await nextSeq(db, SLUG, "dice.other")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// model.ts
// ═══════════════════════════════════════════════════════════════════════════════════════════

async function seededModelDb(): Promise<SqliteDb> {
  const db = makeTestDb();
  await seedProduct(db, SLUG);
  await upsertDeliverable(
    db,
    { product: SLUG, deliverableId: "app", kind: "app" },
    NOW,
  );
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, metadata_access, artifacts_access, created_at, modified_at,
        seq)
     VALUES (?, 'v1.0.0', '1.0.0', 'public', 'public', ?, ?, 1),
            (?, 'v1.1.0', '1.1.0', 'public', 'public', ?, ?, 2)`,
    SLUG,
    NOW,
    NOW,
    SLUG,
    NOW,
    NOW,
  );
  return db;
}

describe("deliverables", () => {
  it("upserts and lists, the app first", async () => {
    const db = await seededModelDb();
    await upsertDeliverable(
      db,
      {
        product: SLUG,
        deliverableId: "dice.core3d",
        kind: "pack",
        packType: "godot.pck",
        defJson: '{"kind":"pack"}',
      },
      NOW,
    );
    expect(
      (await listDeliverables(db, SLUG)).map((d) => [
        d.deliverable_id,
        d.kind,
        d.pack_type,
      ]),
    ).toEqual([
      ["app", "app", null],
      ["dice.core3d", "pack", "godot.pck"],
    ]);
    await upsertDeliverable(
      db,
      {
        product: SLUG,
        deliverableId: "dice.core3d",
        kind: "pack",
        packType: "files.tree",
      },
      NOW + 1,
    );
    expect(await getDeliverable(db, SLUG, "dice.core3d")).toMatchObject({
      pack_type: "files.tree",
      created_at: NOW,
      modified_at: NOW + 1,
    });
  });

  it.each([
    [{ deliverableId: "App", kind: "app" }, /invalid deliverable id/],
    [{ deliverableId: "x", kind: "bundle" }, /unknown deliverable kind/],
    [
      { deliverableId: "app", kind: "app", packType: "godot.pck" },
      /no pack type/,
    ],
  ])("refuses %j", (input, message) => {
    expect(() =>
      stmtUpsertDeliverable(
        { product: SLUG, ...input } as Parameters<
          typeof stmtUpsertDeliverable
        >[0],
        NOW,
      ),
    ).toThrow(message);
  });
});

describe("builds and artifacts", () => {
  it("records builds and lists a build's artifacts, payload first", async () => {
    const db = await seededModelDb();
    await upsertBuild(
      db,
      {
        product: SLUG,
        releaseId: "v1.1.0",
        buildId: "macos",
        platform: "macos",
        arch: "universal",
        format: "dmg",
        buildNumber: "110",
        minOs: "13.0",
      },
      NOW,
    );
    await upsertBuild(
      db,
      {
        product: SLUG,
        releaseId: "v1.1.0",
        buildId: "apk",
        platform: "android",
        arch: "arm64",
        format: "apk",
        buildNumber: "1100",
      },
      NOW,
    );
    expect(
      (await listBuilds(db, SLUG, "v1.1.0")).map((b) => [
        b.build_id,
        b.platform,
        b.arch,
        b.build_number,
      ]),
    ).toEqual([
      ["apk", "android", "arm64", "1100"],
      ["macos", "macos", "universal", "110"],
    ]);

    for (const [id, name] of [
      ["10", "djdl.dmg.sig"],
      ["11", "djdl.dmg"],
    ] as const) {
      await db.run(
        `INSERT INTO release_artifacts
           (product, release_id, artifact_id, name, access, created_at)
         VALUES (?, 'v1.1.0', ?, ?, 'public', ?)`,
        SLUG,
        id,
        name,
        NOW,
      );
    }
    const hash = "a".repeat(64);
    for (const s of [
      stmtSetArtifactModel({
        product: SLUG,
        releaseId: "v1.1.0",
        artifactId: "11",
        buildId: "macos",
        role: "payload",
        sha256: hash,
        storageKey: `blobs/sha256/${hash}`,
        locationsJson: JSON.stringify([{ kind: "r2", sha256: hash }]),
      }),
      stmtSetArtifactModel({
        product: SLUG,
        releaseId: "v1.1.0",
        artifactId: "10",
        buildId: "macos",
        role: "signature",
      }),
    ])
      await db.run(s.sql, ...s.params);
    const files = await listArtifactsForBuild(db, SLUG, "v1.1.0", "macos");
    expect(files.map((f) => [f.name, f.role])).toEqual([
      ["djdl.dmg", "payload"],
      ["djdl.dmg.sig", "signature"],
    ]);
    expect(files[0]).toMatchObject({
      sha256: hash,
      storage_key: `blobs/sha256/${hash}`,
    });
    expect(await listArtifactsForBuild(db, SLUG, "v1.1.0", "apk")).toEqual([]);
  });

  it("validates platform, arch and role against the manifest vocabularies", () => {
    const build = { product: SLUG, releaseId: "v1.0.0", buildId: "b" };
    expect(() =>
      stmtUpsertBuild({ ...build, platform: "ipados" }, NOW),
    ).toThrow(ReleaseModelError);
    expect(() => stmtUpsertBuild({ ...build, arch: "aarch64" }, NOW)).toThrow(
      /unknown arch/,
    );
    expect(() => stmtUpsertBuild({ ...build, buildId: "" }, NOW)).toThrow(
      /build id/,
    );
    // A pack variant may be platform-independent; arch defaults to `any`.
    expect(stmtUpsertBuild({ ...build, platform: null }, NOW).params).toContain(
      "any",
    );
    expect(() =>
      stmtSetArtifactModel({
        product: SLUG,
        releaseId: "v1.0.0",
        artifactId: "1",
        buildId: null,
        role: "installer" as never,
      }),
    ).toThrow(/unknown artifact role/);
    expect(() =>
      stmtSetArtifactModel({
        product: SLUG,
        releaseId: "v1.0.0",
        artifactId: "1",
        buildId: null,
        role: "payload",
        sha256: "ABC",
      }),
    ).toThrow(/sha256/);
  });
});

describe("channel policy", () => {
  const BETA = { product: SLUG, deliverableId: "app", channel: "beta" };
  const MANIFEST = { source: "manifest", by: "manifest", now: NOW } as const;

  it("a manifest write creates a manifest-owned row with defaults for what it omits", async () => {
    const db = await seededModelDb();
    expect(
      await setChannelPolicy(db, BETA, { includes: ["stable"] }, MANIFEST),
    ).toBe(true);
    expect(await getChannelPolicy(db, BETA)).toMatchObject({
      pointer_release_id: null,
      pinned: 0,
      includes_json: '["stable"]',
      min_supported: null,
      critical: 0,
      source: "manifest",
      modified_by: "manifest",
    });
  });

  it("an operator claims the row; the manifest cannot move it; revert hands it back", async () => {
    const db = await seededModelDb();
    await setChannelPolicy(db, BETA, { includes: ["stable"] }, MANIFEST);

    expect(
      await setChannelPolicy(
        db,
        BETA,
        { pointerReleaseId: "v1.0.0", pinned: true, minSupported: "1.0.0" },
        { source: "admin", by: "admin:ops@example.com", now: NOW + 1 },
      ),
    ).toBe(true);
    const claimed = await getChannelPolicy(db, BETA);
    expect(claimed).toMatchObject({
      pointer_release_id: "v1.0.0",
      pinned: 1,
      min_supported: "1.0.0",
      // A promote does not reset what the manifest declared.
      includes_json: '["stable"]',
      source: "admin",
      modified_by: "admin:ops@example.com",
    });

    // What a resync does: refused by the guard, row untouched.
    expect(
      await setChannelPolicy(
        db,
        BETA,
        { includes: [], pinned: false },
        { ...MANIFEST, now: NOW + 2 },
      ),
    ).toBe(false);
    expect(await getChannelPolicy(db, BETA)).toEqual(claimed);

    expect(
      await revertChannelPolicyToManifest(
        db,
        BETA,
        "admin:ops@example.com",
        NOW + 3,
      ),
    ).toBe(true);
    // Only the owner flips; the values wait for the next resync.
    expect(await getChannelPolicy(db, BETA)).toMatchObject({
      source: "manifest",
      pointer_release_id: "v1.0.0",
      includes_json: '["stable"]',
    });
    expect(
      await setChannelPolicy(
        db,
        BETA,
        { includes: null },
        { ...MANIFEST, now: NOW + 4 },
      ),
    ).toBe(true);
    expect(await getChannelPolicy(db, BETA)).toMatchObject({
      source: "manifest",
      includes_json: null,
      modified_at: NOW + 4,
    });
  });

  it("a CI change is an admin change, and a pin needs a pointer", async () => {
    const db = await seededModelDb();
    await setChannelPolicy(
      db,
      { ...BETA, channel: "stable" },
      { critical: true, pointerReleaseId: "v1.1.0" },
      { source: "admin", by: "ci:repo:acme/djdl", now: NOW },
    );
    expect(await listChannelPolicies(db, SLUG, "app")).toEqual([
      expect.objectContaining({
        channel: "stable",
        critical: 1,
        source: "admin",
        modified_by: "ci:repo:acme/djdl",
      }),
    ]);
    await expect(
      setChannelPolicy(db, BETA, { pinned: true }, { ...MANIFEST }),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      setChannelPolicy(
        db,
        { ...BETA, deliverableId: "Not An Id" },
        {},
        MANIFEST,
      ),
    ).rejects.toThrow(ReleaseModelError);
  });
});

describe("yanks", () => {
  it("yank, re-yank, unyank — nothing else is deleted", async () => {
    const db = await seededModelDb();
    expect(await isYanked(db, SLUG, "v1.1.0")).toBe(false);
    await yankRelease(
      db,
      SLUG,
      "v1.1.0",
      "crashes on launch",
      "admin:ops",
      NOW,
    );
    await yankRelease(
      db,
      SLUG,
      "v1.1.0",
      "crashes on 13.x",
      "ci:acme",
      NOW + 5,
    );
    expect(await isYanked(db, SLUG, "v1.1.0")).toBe(true);
    expect(await listYanks(db, SLUG)).toEqual([
      {
        product: SLUG,
        release_id: "v1.1.0",
        reason: "crashes on 13.x",
        at: NOW + 5,
        by: "ci:acme",
      },
    ]);
    expect(await unyankRelease(db, SLUG, "v1.1.0")).toBe(true);
    expect(await unyankRelease(db, SLUG, "v1.1.0")).toBe(false);
    expect(await isYanked(db, SLUG, "v1.1.0")).toBe(false);
    expect(
      await db.first(
        "SELECT 1 FROM release_metadata WHERE release_id = 'v1.1.0'",
      ),
    ).not.toBeNull();
    await expect(
      yankRelease(db, SLUG, "v1.0.0", "  ", "admin:ops", NOW),
    ).rejects.toThrow(/reason/);
  });
});
