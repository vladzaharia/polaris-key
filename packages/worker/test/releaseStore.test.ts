/**
 * The release truth store, from the writer that finally exists (P2.T2) — and the finding that
 * writer arms.
 *
 * `release_metadata` / `release_artifacts` / `release_channels` / `release_health` shipped in
 * `0007_backend_contracts.sql` with a fully-wired portal READ path and, in `src/`, no INSERT at
 * all. Every row the portal has ever listed came from a test fixture. This suite covers the two
 * halves of changing that:
 *
 *   1. resync populates the four tables from the GitHub release list, in the same pass and the
 *      same batch as the manifest rows, and re-running it converges rather than duplicating.
 *   2. R6-12 — the `/download/<token>` open redirect that was rated **dormant** solely because
 *      `source_url` had no writer. It has one now, so the redirect is host-validated and the
 *      single-use claim is proved atomic under a database that actually yields.
 */

import { describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { makeEnv, NOW, seedLicenseWithKey, seedProduct } from "./seed.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Db, DbParam, DbStatement } from "../src/db/types.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/services/release/githubApp.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import { resyncRepo } from "../src/services/release/resync.js";
import {
  listReleaseArtifacts,
  listReleaseChannels,
  listReleaseHealth,
  listReleaseMetadata,
  releaseStoreStatements,
} from "../src/services/release/store.js";
import {
  createPortalDownloadToken,
  markPortalDownloadUsed,
} from "../src/services/identity/portal/repo.js";
import { handlePortalDownload } from "../src/services/identity/portal/api.js";
import { getOrCreateAccountByEmail } from "../src/services/identity/portal/repo.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";

const SLUG = "djdl";

function asset(name: string, id: number, size = 1024): ReleaseAsset {
  return {
    id,
    name,
    size,
    content_type: "application/octet-stream",
    browser_download_url: `https://github.com/acme/djdl/releases/download/v1.2.3/${name}`,
  };
}

function release(over: Partial<Release> = {}): Release {
  return {
    tag_name: "v1.2.3",
    name: "1.2.3",
    body: null,
    published_at: "2026-01-02T03:04:05Z",
    html_url: "https://github.com/acme/djdl/releases/tag/v1.2.3",
    prerelease: false,
    draft: false,
    assets: [],
    ...over,
  };
}

const CFG = {
  product: SLUG,
  gh_owner: "acme",
  gh_repo: "djdl",
  gh_installation_id: 42,
  channel_workflow: null,
  beta_branch: "main",
  manual_channels_json: JSON.stringify([
    { name: "nightly", regex: "v\\d+\\.\\d+\\.\\d+-nightly\\.\\d+" },
  ]),
  binary_name: "djdl",
  install_template: null,
  sparkle_ed25519_pub: null,
  summary_marker: "pkey:summary",
  artifact_policy_json: null,
  metadata_access: "public",
  artifacts_access: "public",
};

async function seedCfg(db: Db, over: Record<string, unknown> = {}) {
  const row = { ...CFG, ...over };
  await db.run(
    `INSERT INTO release_config
       (product, gh_owner, gh_repo, gh_installation_id, channel_workflow, beta_branch,
        manual_channels_json, binary_name, install_template, sparkle_ed25519_pub, summary_marker,
        artifact_policy_json, metadata_access, artifacts_access)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.product,
    row.gh_owner,
    row.gh_repo,
    row.gh_installation_id,
    row.channel_workflow,
    row.beta_branch,
    row.manual_channels_json,
    row.binary_name,
    row.install_template,
    row.sparkle_ed25519_pub,
    row.summary_marker,
    row.artifact_policy_json,
    row.metadata_access,
    row.artifacts_access,
  );
}

function envFor(): Env {
  const env = makeEnv(new KvMock(), [SLUG]);
  env.GITHUB_APP_ID = "12345";
  env.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  return env;
}

/** The minimum manifest a resync accepts: a catalog and a product block naming this slug. */
const MANIFEST: Record<string, string> = {
  ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
  ".pkey/product.json": JSON.stringify({
    slug: SLUG,
    name: "DJDL",
    compatMin: "0.0.0",
    compatMax: "99.0.0",
    defaultMaxOfflineDays: 30,
    defaultDeviceLimit: 5,
    modules: { license: true, releases: true },
  }),
};

/** Encode UTF-8 text the way the GitHub Contents API does. */
function contents(text: string): Response {
  return new Response(
    JSON.stringify({
      content: Buffer.from(text, "utf8").toString("base64"),
      encoding: "base64",
    }),
    { status: 200 },
  );
}

/** A GitHub stub: installation + token, the manifest files, then the release list. */
function stubFetch(
  releases: Release[],
  opts: { releasesStatus?: number } = {},
): { fetchImpl: FetchImpl; listCalls: () => number } {
  let listCalls = 0;
  const fetchImpl: FetchImpl = async (input) => {
    const url = String(input);
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/releases?per_page")) {
      listCalls += 1;
      if (opts.releasesStatus)
        return new Response("boom", { status: opts.releasesStatus });
      return new Response(JSON.stringify(releases), { status: 200 });
    }
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(MANIFEST)) {
        if (url.includes(`/contents/${path}`)) return contents(body);
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("nope", { status: 404 });
  };
  return { fetchImpl, listCalls: () => listCalls };
}

async function seedLinkedProduct(db: SqliteDb): Promise<void> {
  await seedProduct(db, SLUG);
  await db.run(
    "UPDATE products SET release_source = 'github' WHERE slug = ?",
    SLUG,
  );
  await seedCfg(db);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Ingestion
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("resync populates the release truth store", () => {
  const RELEASES = [
    release({
      tag_name: "v2.0.0-beta.1",
      prerelease: true,
      published_at: "2026-02-01T00:00:00Z",
      assets: [asset("djdl-2.0.0-beta.1-arm64.dmg", 11)],
    }),
    release({
      tag_name: "v1.2.3",
      assets: [
        asset("djdl-1.2.3-arm64.dmg", 21, 4096),
        asset("djdl-1.2.3-arm64.dmg.sig", 22, 96),
        asset("djdl-x86_64", 23, 2048),
      ],
    }),
    // A draft is visible to the installation token and to nobody the portal serves.
    release({
      tag_name: "v3.0.0",
      draft: true,
      assets: [asset("secret.dmg", 31)],
    }),
  ];

  it("writes metadata, artifacts, channels and health in the resync pass", async () => {
    const db = makeTestDb();
    await seedLinkedProduct(db);
    const { fetchImpl } = stubFetch(RELEASES);

    const result = await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.updated).toContain("releases");

    const metadata = await listReleaseMetadata(db, SLUG);
    // Newest first, and the draft is absent.
    expect(metadata.map((r) => r.release_id)).toEqual([
      "v2.0.0-beta.1",
      "v1.2.3",
    ]);
    const stable = metadata.find((r) => r.release_id === "v1.2.3")!;
    expect(stable.version).toBe("1.2.3");
    expect(stable.source_url).toBe(
      "https://github.com/acme/djdl/releases/tag/v1.2.3",
    );
    expect(stable.published_at).toBe(
      Math.floor(Date.parse("2026-01-02T03:04:05Z") / 1000),
    );

    const artifacts = await listReleaseArtifacts(db, SLUG, "v1.2.3");
    expect(artifacts.map((a) => a.name).sort()).toEqual([
      "djdl-1.2.3-arm64.dmg",
      "djdl-1.2.3-arm64.dmg.sig",
      "djdl-x86_64",
    ]);
    const dmg = artifacts.find((a) => a.name === "djdl-1.2.3-arm64.dmg")!;
    expect(dmg).toMatchObject({
      artifact_id: "21",
      kind: "dmg",
      platform: "macos",
      arch: "arm64",
      // The gateway's choice, never the uploader's `content_type` (R6-04).
      content_type: "application/x-apple-diskimage",
      size_bytes: 4096,
      access: "public",
    });
    // The ONLY host that ever reaches `source_url` (R6-12's second layer).
    expect(new URL(dmg.source_url!).hostname).toBe("github.com");
    expect(artifacts.find((a) => a.name === "djdl-x86_64")).toMatchObject({
      kind: "cli",
      arch: "x86_64",
    });

    const channels = await listReleaseChannels(db, SLUG);
    expect(
      Object.fromEntries(channels.map((c) => [c.channel, c.release_id])),
    ).toEqual({
      stable: "v1.2.3",
      beta: "v2.0.0-beta.1",
      // The manual rule matches no tag in this list, which is a real answer, not a failure.
      nightly: null,
    });

    const health = await listReleaseHealth(db, SLUG);
    expect(
      health
        .filter((h) => h.subject_kind === "release")
        .map((h) => [h.subject_id, h.status]),
    ).toEqual([
      ["v1.2.3", "healthy"],
      ["v2.0.0-beta.1", "healthy"],
    ]);
    expect(
      health
        .filter((h) => h.subject_kind === "channel")
        .map((h) => [h.subject_id, h.status]),
    ).toEqual([
      ["beta", "healthy"],
      ["nightly", "unknown"],
      ["stable", "healthy"],
    ]);
  });

  it("repopulates idempotently — a second resync converges, it does not duplicate", async () => {
    const db = makeTestDb();
    await seedLinkedProduct(db);
    const { fetchImpl } = stubFetch(RELEASES);

    await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    const first = {
      metadata: await listReleaseMetadata(db, SLUG),
      artifacts: await listReleaseArtifacts(db, SLUG, "v1.2.3"),
      channels: await listReleaseChannels(db, SLUG),
    };

    await resyncRepo(envFor(), db, SLUG, NOW + 60, fetchImpl);
    const second = {
      metadata: await listReleaseMetadata(db, SLUG),
      artifacts: await listReleaseArtifacts(db, SLUG, "v1.2.3"),
      channels: await listReleaseChannels(db, SLUG),
    };

    expect(second.metadata).toHaveLength(first.metadata.length);
    expect(second.artifacts).toHaveLength(first.artifacts.length);
    expect(second.channels).toHaveLength(first.channels.length);
    // `created_at` is the row's first sighting and survives; `modified_at` tracks the sync.
    expect(second.metadata[0]!.created_at).toBe(first.metadata[0]!.created_at);
    expect(second.metadata[0]!.modified_at).toBe(NOW + 60);
  });

  it("follows a moved channel head rather than pinning the first answer", async () => {
    const db = makeTestDb();
    await seedLinkedProduct(db);
    await resyncRepo(envFor(), db, SLUG, NOW, stubFetch(RELEASES).fetchImpl);
    expect(
      (await listReleaseChannels(db, SLUG)).find((c) => c.channel === "stable")!
        .release_id,
    ).toBe("v1.2.3");

    const withNewer = [
      release({ tag_name: "v1.3.0", published_at: "2026-03-01T00:00:00Z" }),
      ...RELEASES,
    ];
    await resyncRepo(
      envFor(),
      db,
      SLUG,
      NOW + 60,
      stubFetch(withNewer).fetchImpl,
    );
    expect(
      (await listReleaseChannels(db, SLUG)).find((c) => c.channel === "stable")!
        .release_id,
    ).toBe("v1.3.0");
    // The superseded release is still listed — the store records what exists, not just what is
    // current, and the portal's history would otherwise vanish on every release.
    expect(
      (await listReleaseMetadata(db, SLUG)).map((r) => r.release_id),
    ).toContain("v1.2.3");
  });

  it("never fails the manifest sync when GitHub cannot answer", async () => {
    const db = makeTestDb();
    await seedLinkedProduct(db);
    const { fetchImpl } = stubFetch([], { releasesStatus: 502 });

    const result = await resyncRepo(envFor(), db, SLUG, NOW, fetchImpl);
    // The manifest half still applied; the truth store simply did not run, and says so by
    // omission rather than by taking the whole sync down with it.
    expect(result.ok).toBe(true);
    expect(result.ok && result.updated).toContain("product");
    expect(result.ok && result.updated).not.toContain("releases");
    expect(await listReleaseMetadata(db, SLUG)).toEqual([]);
  });

  it("maps the entitled access mode to the strictest thing the portal can enforce", () => {
    // `release_metadata`/`release_artifacts` were created with
    // `CHECK (… IN ('public','authenticated','licensed'))` and `entitled` postdates them. The
    // portal has no device token to evaluate a grant against, so it stores `licensed` — a
    // tightening, never a downgrade.
    const stmts = releaseStoreStatements(
      SLUG,
      { ...CFG, metadata_access: "entitled", artifacts_access: "entitled" },
      [release({ assets: [asset("djdl-arm64.dmg", 1)] })],
      NOW,
    );
    const artifactStmt = stmts.find((s) =>
      s.sql.includes("INSERT INTO release_artifacts"),
    )!;
    expect(artifactStmt.params).toContain("licensed");
    expect(artifactStmt.params).not.toContain("entitled");
  });

  it("emits every metadata row before anything that references it", () => {
    // `release_artifacts` and `release_channels` both carry a foreign key into
    // `release_metadata`, and D1 enforces FKs per statement inside a batch. better-sqlite3 does
    // not (PRAGMA foreign_keys is off), so ordering has to be asserted rather than observed.
    const stmts = releaseStoreStatements(
      SLUG,
      CFG,
      [release({ assets: [asset("djdl-arm64.dmg", 1)] })],
      NOW,
    );
    const lastMetadata = stmts.findLastIndex((s) =>
      s.sql.includes("INSERT INTO release_metadata"),
    );
    const firstReferencing = stmts.findIndex(
      (s) =>
        s.sql.includes("INSERT INTO release_artifacts") ||
        s.sql.includes("INSERT INTO release_channels"),
    );
    expect(lastMetadata).toBeGreaterThanOrEqual(0);
    expect(firstReferencing).toBeGreaterThan(lastMetadata);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The portal, over real rows
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("the portal serves the populated store", () => {
  it("lists the releases and artifacts a resync wrote", async () => {
    const db = makeTestDb();
    await seedLinkedProduct(db);
    await resyncRepo(
      envFor(),
      db,
      SLUG,
      NOW,
      stubFetch([
        release({ assets: [asset("djdl-1.2.3-arm64.dmg", 21, 4096)] }),
      ]).fetchImpl,
    );

    const rows = await listReleaseMetadata(db, SLUG);
    expect(rows).toHaveLength(1);
    const artifacts = await listReleaseArtifacts(db, SLUG, rows[0]!.release_id);
    expect(artifacts).toHaveLength(1);
    // Everything the portal's view projects is present and non-null.
    expect(artifacts[0]).toMatchObject({
      name: "djdl-1.2.3-arm64.dmg",
      size_bytes: 4096,
      arch: "arm64",
      platform: "macos",
    });
    expect(artifacts[0]!.source_url).toMatch(/^https:\/\/github\.com\//);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// R6-12 — armed, and closed
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** A `Db` that yields on every call, modelling D1's async round-trips. better-sqlite3 is
 *  synchronous and hides every check-then-act window behind its own atomicity. */
function yieldingDb(inner: Db): Db {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    all: async <T>(sql: string, ...p: DbParam[]) => {
      await tick();
      return inner.all<T>(sql, ...p);
    },
    first: async <T>(sql: string, ...p: DbParam[]) => {
      await tick();
      return inner.first<T>(sql, ...p);
    },
    run: async (sql: string, ...p: DbParam[]) => {
      await tick();
      return inner.run(sql, ...p);
    },
    runChanges: async (sql: string, ...p: DbParam[]) => {
      await tick();
      return inner.runChanges(sql, ...p);
    },
    batch: async (stmts: DbStatement[]) => {
      await tick();
      return inner.batch(stmts);
    },
  } as Db;
}

async function seedDownloadable(
  db: Db,
  env: Env,
  sourceUrl: string,
): Promise<void> {
  await db.run(
    `INSERT INTO release_metadata
       (product, release_id, version, title, notes, commit_sha, source_url,
        metadata_access, artifacts_access, published_at, metadata_json, created_at, modified_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "v1.2.3",
    "1.2.3",
    "DJDL 1.2.3",
    null,
    null,
    "https://github.com/acme/djdl/releases/tag/v1.2.3",
    "public",
    "public",
    NOW,
    null,
    NOW,
    NOW,
  );
  await db.run(
    `INSERT INTO release_artifacts
       (product, release_id, artifact_id, name, kind, platform, arch, content_type,
        size_bytes, sha256, source_url, storage_key, sparkle_signature, access,
        metadata_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    SLUG,
    "v1.2.3",
    "21",
    "djdl.dmg",
    "dmg",
    "macos",
    "arm64",
    "application/x-apple-diskimage",
    4096,
    null,
    sourceUrl,
    null,
    null,
    "public",
    null,
    NOW,
  );
  void env;
}

/** A portal account holding a linked, usable licence for the product. */
async function seedPortalAccount(db: Db): Promise<string> {
  const account = await getOrCreateAccountByEmail(db, "ada@example.com", NOW);
  const accountIdReal = account.id;
  const { licenseId } = await seedLicenseWithKey(db, SLUG);
  await db.run(
    `INSERT INTO portal_license_links
       (account_id, product, license_id, source, created_at, last_seen_at)
     VALUES (?,?,?,?,?,?)`,
    accountIdReal,
    SLUG,
    licenseId,
    "license-key",
    NOW,
    NOW,
  );
  return accountIdReal;
}

function downloadReq(token: string): Request {
  return new Request(
    `https://key.plrs.im/download/${encodeURIComponent(token)}`,
  ) as unknown as Request;
}

describe("R6-12 /download/<token>", () => {
  async function fixture(sourceUrl: string) {
    const db = makeTestDb();
    const env = makeEnv(new KvMock(), [SLUG]);
    await seedProduct(db, SLUG);
    const accountId = await seedPortalAccount(db);
    await seedDownloadable(db, env, sourceUrl);
    const token = await createPortalDownloadToken(env, db, {
      accountId,
      product: SLUG,
      releaseId: "v1.2.3",
      artifactId: "21",
      now: NOW,
    });
    return { db, env, token };
  }

  it("redirects to an allowlisted GitHub storage host", async () => {
    const { db, env, token } = await fixture(
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
    );
    const res = await handlePortalDownload(
      downloadReq(token),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://github.com/acme/djdl/releases/download/v1.2.3/djdl.dmg",
    );
  });

  it.each([
    ["https://attacker.example/pwned.dmg", "a foreign host"],
    ["https://github.com.attacker.example/x.dmg", "a suffix-confusion host"],
    ["http://github.com/acme/djdl/x.dmg", "plaintext http"],
    ["javascript:alert(1)", "a non-http scheme"],
    ["not a url at all", "an unparseable value"],
  ])("never 302s to %s (%s)", async (sourceUrl) => {
    const { db, env, token } = await fixture(sourceUrl);
    const res = await handlePortalDownload(
      downloadReq(token),
      env,
      db,
      token,
      NOW,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });

  it("rejects a double spend even when the database yields between reads", async () => {
    const { db, env, token } = await fixture(
      "https://objects.githubusercontent.com/acme/djdl.dmg",
    );
    const racy = yieldingDb(db);

    // Both redemptions are in flight across the same await points a real D1 would introduce.
    const [a, b] = await Promise.all([
      handlePortalDownload(downloadReq(token), env, racy, token, NOW),
      handlePortalDownload(downloadReq(token), env, racy, token, NOW),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([302, 404]);

    // …and a third, serialised, attempt is refused too.
    const third = await handlePortalDownload(
      downloadReq(token),
      env,
      db,
      token,
      NOW,
    );
    expect(third.status).toBe(404);
  });

  it("makes the claim itself the gate: exactly one caller sees changes === 1", async () => {
    const { db, env, token } = await fixture(
      "https://github.com/acme/djdl/x.dmg",
    );
    const hash = (await db.first<{ token_hash: string }>(
      "SELECT token_hash FROM release_download_tokens LIMIT 1",
    ))!.token_hash;
    void env;
    const claims = await Promise.all(
      Array.from({ length: 5 }, () =>
        markPortalDownloadUsed(yieldingDb(db), SLUG, hash, NOW),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});
