/**
 * HA-08 — release-file mirroring (`services/release/mirror.ts`, `src/assetQueue.ts`; notes/S-20
 * §4.3, §6.3 "Mirror a release file", §6.8).
 *
 * The brief's acceptance criteria are the first two `it`s: after a sync, a fixture release's
 * files serve from R2 with an unchanged ETag/sha256; corrupted bytes are refused and GitHub keeps
 * serving. The rest pin the rules: both hashes must agree, nothing unverifiable is copied, an
 * external location is mirrored too, only app releases, a row a descriptor rewrote meanwhile is
 * never overwritten, the legacy `/dl/…` alias prefers the copy, and the backfill, the operator's
 * action and the queue messages behave.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "./helpers.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import { blobKey } from "../src/core/blobs.js";
import {
  HOSTED_ASSET_REF,
  ingest,
  releaseFileTimeoutMs,
  SLOT_CLASSES,
} from "../src/core/hostedAssets.js";
import {
  readAssetLadderMessage,
  readAssetPullMessage,
  PULL_BACKOFF_BASE_SECONDS,
  syncHostedAssets,
} from "../src/core/hostedAssetPulls.js";
import {
  SAFE_FETCH_FILE_TIMEOUT_MS,
  SAFE_FETCH_TIMEOUT_MS,
  safeFetchTimeoutMs,
} from "../src/core/safeFetch.js";
import { handleAssetQueue, MIRROR_BATCH_BUDGET_MS } from "../src/assetQueue.js";
import { syncReleaseStoreReport } from "../src/services/release/sync.js";
import { stmtSetArtifactModel } from "../src/services/release/model.js";
import {
  backfillReleaseMirrors,
  enqueueReleaseMirrors,
  MIRROR_BACKFILL_MAX_PER_RUN,
  owedCount,
  processReleaseMirror,
  readReleaseMirrorMessage,
  RELEASE_ARTIFACT_REF,
  type ReleaseMirrorMessage,
} from "../src/services/release/mirror.js";
import { handleAdmin } from "../src/admin/index.js";
import {
  ADMIN_COOKIE,
  CSRF_HEADER,
  issueSession,
} from "../src/admin/session.js";
import type { Release, ReleaseAsset } from "../src/services/release/github.js";
import {
  ASSET_BYTES,
  BYTES,
  call,
  CONSOLE,
  enableServices,
  envFor,
  github,
  release,
  seedReleaseProduct,
  sha256Hex,
  SLUG,
} from "./releaseRoutesFixture.js";
import { NOW } from "./seed.js";
import { setAssetHosting, setProductAssetSetting } from "./hostedFixture.js";
import { assetUsage } from "../src/core/assetQuota.js";
import { mirrorNow } from "../src/services/release/mirror.js";

beforeAll(() => installDigestStream());

/** A fixture asset as GitHub lists it now: with its `digest` (S-20 §5: every asset has one). */
function asset(id: number, name: string, digest = true): ReleaseAsset {
  const bytes = ASSET_BYTES[id]!;
  return {
    id,
    name,
    size: bytes.length,
    content_type: "text/html",
    browser_download_url: `https://github.com/acme/djdl/releases/download/x/${name}`,
    ...(digest ? { digest: `sha256:${sha256Hex(bytes)}` } : {}),
  };
}

const RELEASES: Release[] = [
  release("v1.1.0", [
    asset(201, "djdl-arm64"),
    asset(202, "djdl-1.1.0-arm64.dmg"),
  ]),
  release("v1.0.0", [
    asset(101, "djdl-arm64"),
    asset(102, "djdl-1.0.0-arm64.dmg"),
  ]),
];

interface Stub {
  fetchImpl: FetchImpl;
  calls: { api: string[]; storage: string[]; other: string[] };
  /** Bytes the storage host serves instead of the real ones, by asset id. */
  corrupt: Map<number, Uint8Array>;
  /** External hosts' bodies, by URL. */
  external: Map<string, Uint8Array>;
}

/**
 * The fixture's GitHub stub (`releaseRoutesFixture.ts`), plus what mirroring asks for: an asset's
 * metadata as JSON (`Accept: application/vnd.github+json`), corrupted storage bytes on demand,
 * and an external host.
 */
function stub(releases: Release[] = RELEASES): Stub {
  const gh = github({ releases });
  const corrupt = new Map<number, Uint8Array>();
  const external = new Map<string, Uint8Array>();
  const other: string[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const headers = new Headers(
      typeof input === "string" ? init?.headers : input.headers,
    );
    const u = new URL(url);
    if (external.has(url)) {
      other.push(url);
      const body = external.get(url)!;
      return new Response(body, {
        headers: { "content-length": String(body.length) },
      });
    }
    if (u.hostname === "objects.githubusercontent.com") {
      const id = Number(u.pathname.split("/").pop());
      const bad = corrupt.get(id);
      if (bad) {
        gh.calls.storage.push(url);
        return new Response(bad, {
          headers: { "content-length": String(bad.length) },
        });
      }
    }
    const meta = /\/releases\/assets\/(\d+)$/.exec(u.pathname)?.[1];
    if (
      meta &&
      u.hostname === "api.github.com" &&
      (headers.get("accept") ?? "").includes("application/vnd.github+json")
    ) {
      gh.calls.api.push(url);
      const found = releases
        .flatMap((r) => r.assets)
        .find((a) => a.id === Number(meta));
      return found
        ? new Response(JSON.stringify(found), { status: 200 })
        : new Response("nf", { status: 404 });
    }
    return gh.fetchImpl(url, {
      ...init,
      headers: Object.fromEntries(headers.entries()),
    });
  };
  return { fetchImpl, calls: { ...gh.calls, other }, corrupt, external };
}

function fakeQueue() {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      async sendBatch(msgs: Iterable<{ body: unknown }>) {
        for (const m of msgs) sent.push(m.body);
      },
      async send(body: unknown) {
        sent.push(body);
      },
    } as unknown as Queue<unknown>,
  };
}

let db: SqliteDb;
let r2: R2Mock;
let q: ReturnType<typeof fakeQueue>;
let env: Env;
let gh: Stub;

beforeEach(async () => {
  db = makeTestDb();
  r2 = new R2Mock();
  q = fakeQueue();
  env = envFor({ blobOrigin: BYTES });
  env.BLOBS = asR2(r2);
  env.HOSTED_ASSET_QUEUE = q.queue;
  gh = stub();
  await seedReleaseProduct(db);
});

/** Deliver every message sent since `from` to the consumer, as the queue would. */
async function drain(
  now = NOW + 10,
  from = 0,
  bodies: unknown[] = q.sent.slice(from),
  elapsedMs?: () => number,
) {
  const acked: number[] = [];
  const retried: { i: number; delaySeconds?: number }[] = [];
  await handleAssetQueue(
    {
      queue: "pkey-assets-test",
      messages: bodies.map((body, i) => ({
        body,
        ack: () => acked.push(i),
        retry: (o?: { delaySeconds?: number }) =>
          retried.push({
            i,
            ...(o?.delaySeconds ? { delaySeconds: o.delaySeconds } : {}),
          }),
      })),
    } as unknown as MessageBatch<unknown>,
    env,
    db,
    gh.fetchImpl,
    () => now,
    elapsedMs,
  );
  return { bodies, acked, retried };
}

const sync = () => syncReleaseStoreReport(env, db, SLUG, NOW, gh.fetchImpl);
const get = (url: string, init: RequestInit = {}) =>
  call(env, db, gh.fetchImpl, url, init);

function artifact(releaseId: string, artifactId: string) {
  return db.first<{
    sha256: string | null;
    locations_json: string | null;
  }>(
    "SELECT sha256, locations_json FROM release_artifacts WHERE product = ? AND release_id = ? AND artifact_id = ?",
    SLUG,
    releaseId,
    artifactId,
  );
}

function job(releaseId: string, artifactId: string) {
  return db.first<Record<string, unknown>>(
    "SELECT * FROM release_mirrors WHERE product = ? AND release_id = ? AND artifact_id = ?",
    SLUG,
    releaseId,
    artifactId,
  );
}

function mirrorRefs() {
  return db.all<{ storage_key: string; ref_id: string }>(
    "SELECT storage_key, ref_id FROM blob_refs WHERE product = ? AND ref_kind = ? ORDER BY ref_id",
    SLUG,
    RELEASE_ARTIFACT_REF,
  );
}

const hexOf = async (res: Response) =>
  sha256Hex(new Uint8Array(await res.arrayBuffer()));

function msg(releaseId: string, artifactId: string): ReleaseMirrorMessage {
  return {
    v: 1,
    kind: "release-mirror",
    product: SLUG,
    releaseId,
    artifactId,
    reason: "sync",
  };
}

const ctx = (now = NOW + 10) => ({ env, db, now, fetchImpl: gh.fetchImpl });

describe("release-file mirroring (acceptance)", () => {
  it("after a sync, a fixture release's files serve from R2 with an unchanged ETag/sha256", async () => {
    const digest = sha256Hex(ASSET_BYTES[201]!);
    const url = `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`;

    // The sync queues one mirror per file; nothing is copied on the sync's own request.
    await sync();
    expect(q.sent).toHaveLength(4);
    expect(
      q.sent.map((m) => readReleaseMirrorMessage(m)?.artifactId).sort(),
    ).toEqual(["101", "102", "201", "202"]);
    expect(r2.has(blobKey(digest))).toBe(false);

    // Before the copy: streamed from GitHub's storage.
    gh.calls.storage.length = 0;
    const before = await get(url);
    expect(before.status).toBe(200);
    expect(await hexOf(before)).toBe(digest);
    expect(gh.calls.storage).toHaveLength(1);

    const { acked, retried } = await drain();
    expect(acked).toEqual([0, 1, 2, 3]);
    expect(retried).toEqual([]);

    // The copy, its hosted-asset row and refs, the appended location and the job row.
    expect(r2.has(blobKey(digest))).toBe(true);
    const row = await artifact("v1.1.0", "201");
    expect(row?.sha256).toBe(digest);
    expect(JSON.parse(row!.locations_json!)).toEqual([
      { provider: "github" },
      { provider: "r2", key: blobKey(digest) },
    ]);
    expect(await job("v1.1.0", "201")).toMatchObject({
      status: "ready",
      source_ref: "github:201",
      sha256: digest,
      error: null,
      attempts: 0,
      next_attempt_at: null,
    });
    expect((await mirrorRefs()).map((r) => r.ref_id)).toEqual([
      "v1.0.0/101",
      "v1.0.0/102",
      "v1.1.0/201",
      "v1.1.0/202",
    ]);
    expect(
      await db.first(
        "SELECT origin, source_kind, source_ref, status FROM hosted_assets WHERE product = ? AND slot = ?",
        SLUG,
        `release-file:${digest}`,
      ),
    ).toEqual({
      origin: "release-mirror",
      source_kind: "github-asset",
      source_ref: "201",
      status: "ready",
    });
    expect(
      await db.first(
        "SELECT 1 AS one FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ?",
        SLUG,
        HOSTED_ASSET_REF,
        `release-file:${digest}@`,
      ),
    ).toEqual({ one: 1 });
    expect(
      await db.first(
        "SELECT COUNT(*) AS n FROM audit WHERE product = ? AND action = 'release.mirror'",
        SLUG,
      ),
    ).toEqual({ n: 4 });

    // After: the same URL answers from R2, without GitHub, with the bytes' own hash as its ETag.
    gh.calls.storage.length = 0;
    gh.calls.api.length = 0;
    const after = await get(url);
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).toBe(`"${digest}"`);
    expect(after.headers.get("repr-digest")).toBeTruthy();
    expect(after.headers.get("cache-control")).toBe(
      "public, max-age=3600, no-transform",
    );
    expect(await hexOf(after)).toBe(digest);
    expect(gh.calls.storage).toEqual([]);
    expect(gh.calls.api).toEqual([]);

    // The DMG keeps its type on the bytes host, now from the copy.
    const dmg = await get(
      `${BYTES}/${SLUG}/distribution/files/v1.0.0/djdl-1.0.0-arm64.dmg`,
    );
    expect(dmg.headers.get("content-type")).toBe(
      "application/x-apple-diskimage",
    );
    expect(new Uint8Array(await dmg.arrayBuffer())).toEqual(ASSET_BYTES[102]);
    expect(gh.calls.storage).toEqual([]);

    // A second sync owes nothing more, and the sync's own columns did not undo the location.
    const sent = q.sent.length;
    await sync();
    expect(q.sent).toHaveLength(sent);
    expect(
      JSON.parse((await artifact("v1.1.0", "201"))!.locations_json!),
    ).toHaveLength(2);
    expect(await owedCount(db, SLUG)).toBe(0);
  });

  it("corrupted bytes are refused and GitHub keeps serving", async () => {
    const digest = sha256Hex(ASSET_BYTES[201]!);
    const bad = ASSET_BYTES[201]!.slice();
    bad[100] = bad[100]! ^ 0xff;
    gh.corrupt.set(201, bad);

    await sync();
    const outcome = await processReleaseMirror(ctx(), msg("v1.1.0", "201"));
    expect(outcome).toBe("failed");

    // Nothing promoted: no object, no ref, no location.
    expect(r2.has(blobKey(digest))).toBe(false);
    expect(r2.has(blobKey(sha256Hex(bad)))).toBe(false);
    expect(await mirrorRefs()).toEqual([]);
    expect((await artifact("v1.1.0", "201"))?.locations_json).toBeNull();
    expect(await job("v1.1.0", "201")).toMatchObject({
      status: "failed",
      error: "sha256-mismatch",
      attempts: 1,
      next_attempt_at: NOW + 10 + PULL_BACKOFF_BASE_SECONDS,
    });

    // GitHub keeps serving the real bytes.
    gh.corrupt.clear();
    gh.calls.storage.length = 0;
    const res = await get(
      `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-arm64`,
    );
    expect(res.status).toBe(200);
    expect(await hexOf(res)).toBe(digest);
    expect(gh.calls.storage).toHaveLength(1);

    // Held off while its back-off runs: a sync in the meantime does not queue it again.
    const sent = q.sent.length;
    await enqueueReleaseMirrors(env, db, SLUG, NOW + 20);
    expect(
      q.sent.slice(sent).map((m) => readReleaseMirrorMessage(m)?.artifactId),
    ).not.toContain("201");
    // Once it has elapsed, the next try copies it.
    const later = NOW + 10 + PULL_BACKOFF_BASE_SECONDS;
    expect(await processReleaseMirror(ctx(later), msg("v1.1.0", "201"))).toBe(
      "mirrored",
    );
    expect(await job("v1.1.0", "201")).toMatchObject({
      status: "ready",
      attempts: 0,
      error: null,
    });
  });
});

describe("release-file mirroring (rules)", () => {
  it("refuses, before any byte is read, a file whose recorded sha256 and GitHub digest disagree", async () => {
    await sync();
    const other = "e".repeat(64);
    const a = stmtSetArtifactModel({
      product: SLUG,
      releaseId: "v1.1.0",
      artifactId: "201",
      buildId: null,
      role: "payload",
      sha256: other,
    });
    await db.run(a.sql, ...a.params);
    gh.calls.storage.length = 0;
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "failed",
    );
    expect(await job("v1.1.0", "201")).toMatchObject({
      status: "failed",
      error: "digest-mismatch",
    });
    expect(gh.calls.storage).toEqual([]);
  });

  it("copies nothing it cannot verify: no recorded sha256 and no GitHub digest", async () => {
    gh = stub([release("v2.0.0", [asset(301, "djdl-arm64", false)])]);
    await sync();
    gh.calls.storage.length = 0;
    expect(await processReleaseMirror(ctx(), msg("v2.0.0", "301"))).toBe(
      "failed",
    );
    expect(await job("v2.0.0", "301")).toMatchObject({ error: "no-digest" });
    expect(gh.calls.storage).toEqual([]);
  });

  it("a file GitHub no longer has is recorded as failed, never as served", async () => {
    await sync();
    gh = stub([]);
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "failed",
    );
    expect(await job("v1.1.0", "201")).toMatchObject({ error: "github:404" });
    expect((await artifact("v1.1.0", "201"))?.locations_json).toBeNull();
  });

  it("mirrors an external location against the descriptor's sha256, behind the same guard", async () => {
    await sync();
    const bytes = ASSET_BYTES[301]!;
    const hex = sha256Hex(bytes);
    const extUrl = "https://cdn.example.com/djdl-extra.zip";
    gh.external.set(extUrl, bytes);
    await db.run(
      `INSERT INTO release_artifacts (product, release_id, artifact_id, name, kind, size_bytes,
         sha256, access, created_at, role, locations_json)
       VALUES (?, 'v1.1.0', 'file:djdl-extra.zip', 'djdl-extra.zip', 'zip', ?, ?, 'public', ?,
         'payload', ?)`,
      SLUG,
      bytes.length,
      hex,
      NOW,
      JSON.stringify([{ provider: "external", url: extUrl }]),
    );
    const before = q.sent.length;
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW)).toBeGreaterThan(0);
    expect(
      q.sent.slice(before).map((m) => readReleaseMirrorMessage(m)?.artifactId),
    ).toContain("file:djdl-extra.zip");
    expect(
      await processReleaseMirror(ctx(), msg("v1.1.0", "file:djdl-extra.zip")),
    ).toBe("mirrored");
    expect(gh.calls.other).toEqual([extUrl]);
    expect(
      JSON.parse(
        (await artifact("v1.1.0", "file:djdl-extra.zip"))!.locations_json!,
      ),
    ).toEqual([
      { provider: "external", url: extUrl },
      { provider: "r2", key: blobKey(hex) },
    ]);
    expect(await job("v1.1.0", "file:djdl-extra.zip")).toMatchObject({
      status: "ready",
      source_ref: extUrl,
    });

    // The served file is our copy now: no 302 to the external host.
    const res = await get(
      `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-extra.zip`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${hex}"`);
  });

  it("an external location on our own zone is refused by the guard, and nothing is stored", async () => {
    await sync();
    const bytes = ASSET_BYTES[301]!;
    await db.run(
      `INSERT INTO release_artifacts (product, release_id, artifact_id, name, kind, size_bytes,
         sha256, access, created_at, role, locations_json)
       VALUES (?, 'v1.1.0', 'file:x.zip', 'x.zip', 'zip', ?, ?, 'public', ?, 'payload', ?)`,
      SLUG,
      bytes.length,
      sha256Hex(bytes),
      NOW,
      JSON.stringify([
        { provider: "external", url: "https://key.plrs.im/djdl/x.zip" },
      ]),
    );
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "file:x.zip"))).toBe(
      "failed",
    );
    expect(await job("v1.1.0", "file:x.zip")).toMatchObject({
      error: "guard:denied-host",
    });
    expect(r2.has(blobKey(sha256Hex(bytes)))).toBe(false);
  });

  it("never mirrors a release of another deliverable (a pack's or a package's)", async () => {
    await sync();
    await db.run(
      `INSERT INTO release_deliverables (product, deliverable_id, kind, created_at, modified_at)
       VALUES (?, 'pack-x', 'pack', ?, ?) ON CONFLICT DO NOTHING`,
      SLUG,
      NOW,
      NOW,
    );
    await db.run(
      "UPDATE release_metadata SET deliverable_id = 'pack-x' WHERE product = ? AND release_id = 'v1.0.0'",
      SLUG,
    );
    const before = q.sent.length;
    await db.run("DELETE FROM release_mirrors");
    await enqueueReleaseMirrors(env, db, SLUG, NOW + 1000);
    const ids = q.sent
      .slice(before)
      .map((m) => readReleaseMirrorMessage(m)?.releaseId);
    expect(ids).not.toContain("v1.0.0");
    expect(await processReleaseMirror(ctx(), msg("v1.0.0", "101"))).toBe(
      "superseded",
    );
    expect(r2.has(blobKey(sha256Hex(ASSET_BYTES[101]!)))).toBe(false);
  });

  it("never overwrites a row a descriptor rewrote while the copy was being made", async () => {
    await sync();
    const digest = sha256Hex(ASSET_BYTES[201]!);
    const rewritten = JSON.stringify([
      { provider: "github", asset: "djdl-arm64" },
    ]);
    const inner = gh.fetchImpl;
    gh.fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (new URL(url).hostname === "objects.githubusercontent.com")
        await db.run(
          "UPDATE release_artifacts SET locations_json = ? WHERE product = ? AND release_id = 'v1.1.0' AND artifact_id = '201'",
          rewritten,
          SLUG,
        );
      return inner(input, init);
    };
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "superseded",
    );
    expect((await artifact("v1.1.0", "201"))?.locations_json).toBe(rewritten);
    expect(await mirrorRefs()).toEqual([]);
    // The copy itself is a hosted asset and keeps its own ref; the file is owed again.
    expect(r2.has(blobKey(digest))).toBe(true);
    gh.fetchImpl = inner;
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "mirrored",
    );
    expect(
      JSON.parse((await artifact("v1.1.0", "201"))!.locations_json!),
    ).toEqual([
      { provider: "github", asset: "djdl-arm64" },
      { provider: "r2", key: blobKey(digest) },
    ]);
  });

  it("a file that already has an r2 location is left alone", async () => {
    await sync();
    await drain();
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "already",
    );
  });

  it("queues nothing without a queue or a blob store, or with Release off, and never throws", async () => {
    delete env.HOSTED_ASSET_QUEUE;
    await sync();
    expect(q.sent).toEqual([]);
    env.HOSTED_ASSET_QUEUE = q.queue;
    delete env.BLOBS;
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW)).toBe(0);
    env.BLOBS = asR2(r2);
    await enableServices(db, false);
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW)).toBe(0);
    expect(q.sent).toEqual([]);
    const broken = {
      ...db,
      all: async () => {
        throw new Error("D1 down");
      },
    } as unknown as SqliteDb;
    await enableServices(db, true);
    expect(await enqueueReleaseMirrors(env, broken, SLUG, NOW)).toBe(0);
  });
});

describe("HA-10: the switches and the release-file quota", () => {
  const mirrored = async () =>
    (await mirrorRefs()).map((r) => r.ref_id.split("/")[1]).sort();

  it("assets.releases.mirror off keeps GitHub-only serving for the product", async () => {
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.releases.mirror",
      "off",
    );
    await sync();
    expect(q.sent).toEqual([]);
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW)).toBe(0);
    expect(await backfillReleaseMirrors(env, db, NOW)).toBe(0);
    expect(await mirrorNow(env, db, SLUG, NOW)).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "superseded",
    );
    expect(await mirrorRefs()).toEqual([]);
    // Back on (Reset: the default, on), the next sync queues every file again.
    await setProductAssetSetting(env, db, SLUG, "assets.releases.mirror", null);
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW)).toBe(4);
  });

  it("the kill switch off stops mirroring, and the legacy download streams from GitHub again", async () => {
    await sync();
    await drain();
    expect(await mirrored()).toEqual(["101", "102", "201", "202"]);
    await setAssetHosting(env, db, "off");
    // Nothing more is queued or copied.
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW + 20)).toBe(0);
    expect(await mirrorNow(env, db, SLUG, NOW + 20)).toEqual({
      ok: false,
      reason: "disabled",
    });
    // The legacy alias goes back to GitHub; the copies themselves stay.
    gh.calls.storage.length = 0;
    const cli = await get(`${CONSOLE}/${SLUG}/release/dl/1.1.0/djdl-arm64`);
    expect(cli.status).toBe(200);
    expect(new Uint8Array(await cli.arrayBuffer())).toEqual(ASSET_BYTES[201]);
    expect(gh.calls.storage).toHaveLength(1);
    expect(await mirrored()).toEqual(["101", "102", "201", "202"]);
    // Switched back on, the copy serves again.
    await setAssetHosting(env, db, "on");
    gh.calls.storage.length = 0;
    const again = await get(`${CONSOLE}/${SLUG}/release/dl/1.1.0/djdl-arm64`);
    expect(again.status).toBe(200);
    expect(gh.calls.storage).toEqual([]);
  });

  it("past the quota, mirroring stops before anything is downloaded and GitHub keeps serving", async () => {
    // Room for 201 (6,000 bytes) and 102 (3,000 bytes), not for 202 or 101.
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.quota.releaseBytes",
      9_000,
    );
    await sync();
    for (const [r, a] of [
      ["v1.1.0", "201"],
      ["v1.0.0", "102"],
    ] as const)
      expect(await processReleaseMirror(ctx(), msg(r, a))).toBe("mirrored");
    gh.calls.storage.length = 0;
    for (const [r, a] of [
      ["v1.1.0", "202"],
      ["v1.0.0", "101"],
    ] as const) {
      expect(await processReleaseMirror(ctx(), msg(r, a))).toBe("failed");
      expect(await job(r, a)).toMatchObject({
        status: "failed",
        error: "quota",
        attempts: 1,
      });
      expect((await artifact(r, a))?.locations_json ?? "").not.toContain(
        '"r2"',
      );
    }
    // Refused before a byte was fetched.
    expect(gh.calls.storage).toEqual([]);
    expect(await mirrored()).toEqual(["102", "201"]);
    expect((await assetUsage(db, SLUG)).release).toEqual({
      bytes: 9_000,
      files: 2,
    });
    // GitHub keeps serving the files that have no copy.
    const res = await get(
      `${BYTES}/${SLUG}/distribution/files/v1.1.0/djdl-1.1.0-arm64.dmg`,
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ASSET_BYTES[202]);
    expect(gh.calls.storage).toHaveLength(1);
    // At the quota, nothing is queued, and the operator's action says why.
    const sent = q.sent.length;
    expect(await enqueueReleaseMirrors(env, db, SLUG, NOW + 86_400 * 30)).toBe(
      0,
    );
    expect(await backfillReleaseMirrors(env, db, NOW + 86_400 * 30)).toBe(0);
    expect(q.sent.length).toBe(sent);
    expect(await mirrorNow(env, db, SLUG, NOW + 20)).toEqual({
      ok: false,
      reason: "quota",
    });
    // A raised quota lets mirroring resume.
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.quota.releaseBytes",
      null,
    );
    expect(await mirrorNow(env, db, SLUG, NOW + 20)).toMatchObject({
      ok: true,
      queued: 2,
    });
  });

  it("two files racing for the last room: exactly one is copied", async () => {
    await setProductAssetSetting(
      env,
      db,
      SLUG,
      "assets.quota.releaseBytes",
      7_000,
    );
    await sync();
    const out = await Promise.all([
      processReleaseMirror(ctx(), msg("v1.1.0", "201")),
      processReleaseMirror(ctx(), msg("v1.0.0", "101")),
    ]);
    expect(out.filter((o) => o === "mirrored")).toHaveLength(1);
    expect(out.filter((o) => o === "failed")).toHaveLength(1);
    expect((await assetUsage(db, SLUG)).release.bytes).toBeLessThanOrEqual(
      7_000,
    );
    expect(await mirrored()).toHaveLength(1);
  });
});

describe("release-file pulls: the redirect rule, the declared length, the budget", () => {
  it("refuses a GitHub asset whose redirect leaves GitHub's hosts, and stores nothing", async () => {
    await sync();
    const inner = gh.fetchImpl;
    const dialled: string[] = [];
    gh.fetchImpl = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      dialled.push(url);
      const accept = new Headers(init?.headers).get("accept") ?? "";
      if (
        url.endsWith("/releases/assets/201") &&
        accept === "application/octet-stream"
      )
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.evil.example/djdl-arm64" },
        });
      return inner(input, init);
    };
    expect(await processReleaseMirror(ctx(), msg("v1.1.0", "201"))).toBe(
      "failed",
    );
    expect(await job("v1.1.0", "201")).toMatchObject({
      error: "guard:not-allowed",
    });
    expect(dialled).not.toContain("https://cdn.evil.example/djdl-arm64");
    expect(r2.has(blobKey(sha256Hex(ASSET_BYTES[201]!)))).toBe(false);
    expect((await artifact("v1.1.0", "201"))?.locations_json).toBeNull();
  });

  it("refuses a declared Content-Length other than the expected size without reading the body", async () => {
    const bytes = ASSET_BYTES[301]!;
    let pulled = false;
    const res = await ingest(
      {
        env: { BLOBS: asR2(r2) },
        db,
        now: NOW,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(c) {
                  pulled = true;
                  c.enqueue(bytes);
                  c.close();
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-length": String(bytes.length + 1) } },
          ),
      },
      SLUG,
      `release-file:${sha256Hex(bytes)}`,
      {
        kind: "pull",
        url: "https://cdn.example.com/f.zip",
        origin: "release-mirror",
        sourceKind: "url",
        expectedSha256: sha256Hex(bytes),
        expectedSize: bytes.length,
      },
    );
    expect(res).toEqual({ ok: false, reason: "size-mismatch" });
    expect(pulled).toBe(false);
    expect(r2.has(blobKey(sha256Hex(bytes)))).toBe(false);
  });

  it("scales a release file's budget with its size, clamped at 10 minutes, and only a release file gets past 30 s", () => {
    const MiB = 1024 * 1024;
    expect(releaseFileTimeoutMs(0)).toBe(SAFE_FETCH_TIMEOUT_MS);
    expect(releaseFileTimeoutMs(100 * MiB)).toBe(
      SAFE_FETCH_TIMEOUT_MS + 10_000,
    );
    // R2's 4.995 GiB single put fits under the clamp; anything larger is clamped.
    expect(
      releaseFileTimeoutMs(SLOT_CLASSES["release-file"].maxBytes),
    ).toBeLessThan(SAFE_FETCH_FILE_TIMEOUT_MS);
    expect(releaseFileTimeoutMs(8 * 1024 * MiB)).toBe(
      SAFE_FETCH_FILE_TIMEOUT_MS,
    );
    expect(releaseFileTimeoutMs(null)).toBe(SAFE_FETCH_FILE_TIMEOUT_MS);
    expect(SAFE_FETCH_FILE_TIMEOUT_MS).toBe(10 * 60_000);
    // Every other caller stays clamped at the old maximum.
    expect(safeFetchTimeoutMs({ timeoutMs: 20 * 60_000 })).toBe(
      SAFE_FETCH_TIMEOUT_MS,
    );
    expect(
      safeFetchTimeoutMs({ timeoutMs: 20 * 60_000, releaseFile: true }),
    ).toBe(SAFE_FETCH_FILE_TIMEOUT_MS);
    expect(safeFetchTimeoutMs({ timeoutMs: 5_000 })).toBe(5_000);
    expect(safeFetchTimeoutMs({})).toBe(SAFE_FETCH_TIMEOUT_MS);
  });
});

describe("the legacy download prefers the copy", () => {
  it("serves /dl/<version>/<binary>-<arch> from R2 once the asset's digest has a copy, keeping the route's type and cache", async () => {
    await sync();
    await drain();
    gh.calls.storage.length = 0;
    const digest = sha256Hex(ASSET_BYTES[201]!);
    const cli = await get(`${CONSOLE}/${SLUG}/release/dl/1.1.0/djdl-arm64`);
    expect(cli.status).toBe(200);
    expect(cli.headers.get("etag")).toBe(`"${digest}"`);
    expect(cli.headers.get("content-type")).toBe("application/octet-stream");
    expect(cli.headers.get("cache-control")).toBe(
      "public, max-age=86400, immutable",
    );
    expect(await hexOf(cli)).toBe(digest);

    const dmg = await get(
      `${CONSOLE}/${SLUG}/distribution/dl/1.1.0/djdl-arm64.dmg`,
      { headers: { range: "bytes=0-9" } },
    );
    expect(dmg.status).toBe(206);
    expect(dmg.headers.get("content-type")).toBe(
      "application/x-apple-diskimage",
    );
    expect(new Uint8Array(await dmg.arrayBuffer())).toEqual(
      ASSET_BYTES[202]!.slice(0, 10),
    );
    expect(gh.calls.storage).toEqual([]);
  });

  it("streams from GitHub, as before, when there is no copy", async () => {
    await sync();
    gh.calls.storage.length = 0;
    const res = await get(`${CONSOLE}/${SLUG}/release/dl/1.1.0/djdl-arm64`);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(ASSET_BYTES[201]);
    expect(gh.calls.storage).toHaveLength(1);
  });
});

describe("backfill and the operator's action", () => {
  it("the nightly backfill queues owed files across products, bounded, honouring back-off", async () => {
    // Rows the sync wrote before mirroring existed: nothing was queued for them.
    delete env.HOSTED_ASSET_QUEUE;
    await sync();
    env.HOSTED_ASSET_QUEUE = q.queue;
    expect(await owedCount(db, SLUG)).toBe(4);

    expect(await backfillReleaseMirrors(env, db, NOW, 3)).toBe(3);
    expect(MIRROR_BACKFILL_MAX_PER_RUN).toBeGreaterThan(3);
    // The three just queued are held for one step; the fourth is next.
    expect(await backfillReleaseMirrors(env, db, NOW + 1)).toBe(1);
    expect(await backfillReleaseMirrors(env, db, NOW + 2)).toBe(0);
    // Messages lost in flight are queued again once the hold elapses.
    expect(
      await backfillReleaseMirrors(
        env,
        db,
        NOW + 1 + PULL_BACKOFF_BASE_SECONDS,
      ),
    ).toBe(4);

    await drain(NOW + 2 + PULL_BACKOFF_BASE_SECONDS);
    expect(await owedCount(db, SLUG)).toBe(0);
    expect(await backfillReleaseMirrors(env, db, NOW + 86_400)).toBe(0);
  });

  it("POST …/assets/mirror queues every owed file now, back-off or not, never one in flight, and is audited", async () => {
    await sync();
    // Every first try fails (corrupted bytes): each file is now held off by its back-off.
    for (const id of [101, 102, 201, 202])
      gh.corrupt.set(id, new Uint8Array(ASSET_BYTES[id]!.length));
    await drain(NOW + 10);
    gh.corrupt.clear();
    expect(await job("v1.1.0", "201")).toMatchObject({ status: "failed" });
    const { token, session } = await issueSession(
      env,
      {
        sub: "u1",
        name: "Ada",
        email: "ada@x.io",
        groups: ["platform-admins"],
      },
      NOW,
    );
    const path = `/api/products/${SLUG}/assets/mirror`;
    const post = (method = "POST") =>
      handleAdmin(
        new Request(`${CONSOLE}/manage${path}`, {
          method,
          headers: {
            cookie: `${ADMIN_COOKIE}=${token}`,
            [CSRF_HEADER]: session.csrf,
          },
        }),
        env,
        db,
        path,
        { now: NOW + 20 },
      );
    const sent = q.sent.length;
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: 4, owed: 4 });
    expect(q.sent.length - sent).toBe(4);
    expect(
      await db.first(
        "SELECT actor_sub, action FROM audit WHERE product = ? AND action = 'assets.mirror'",
        SLUG,
      ),
    ).toEqual({ actor_sub: "u1", action: "assets.mirror" });

    // Repeated while those messages are in flight: nothing is queued (and downloaded) twice.
    const again = await post();
    expect(await again.json()).toEqual({ queued: 0, owed: 4 });
    expect(q.sent.length - sent).toBe(4);

    expect((await post("GET")).status).toBe(405);
    delete env.HOSTED_ASSET_QUEUE;
    expect((await post()).status).toBe(503);
  });
});

describe("queue messages", () => {
  it("validates a mirror message, and the pull and ladder readers never take one", () => {
    const good = msg("v1.1.0", "201");
    expect(readReleaseMirrorMessage(good)).toEqual(good);
    expect(readAssetPullMessage(good)).toBeNull();
    expect(readAssetLadderMessage(good)).toBeNull();
    for (const bad of [
      null,
      { ...good, v: 2 },
      { ...good, kind: "ladder" },
      { ...good, product: "Bad Slug" },
      { ...good, releaseId: "" },
      { ...good, artifactId: "x".repeat(513) },
      { ...good, reason: "whenever" },
    ])
      expect(readReleaseMirrorMessage(bad)).toBeNull();
  });

  it("a [mirror, pull] batch processes and acks the pull first", async () => {
    await sync();
    const mirror = q.sent[0]!;
    const icon = new Uint8Array(4_000);
    icon.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const iconUrl = "https://cdn.example.com/icon.png";
    gh.external.set(iconUrl, icon);
    await syncHostedAssets(env, db, {
      product: SLUG,
      manifest: { presentation: { icon: { kind: "url", src: iconUrl } } },
      commit: null,
      now: NOW,
    });
    const pull = q.sent.at(-1)!;
    expect(readAssetPullMessage(pull)).not.toBeNull();
    const { acked, retried } = await drain(NOW + 10, 0, [mirror, pull]);
    expect(acked).toEqual([1, 0]);
    expect(retried).toEqual([]);
  });

  it("starts no mirror once the batch budget is spent: the rest are retried, not started", async () => {
    await sync();
    const [first, second] = q.sent as [unknown, unknown];
    const firstId = readReleaseMirrorMessage(first)!;
    const secondId = readReleaseMirrorMessage(second)!;
    let calls = 0;
    gh.calls.storage.length = 0;
    const { acked, retried } = await drain(NOW + 10, 0, [first, second], () =>
      calls++ === 0 ? 0 : MIRROR_BATCH_BUDGET_MS,
    );
    expect(acked).toEqual([0]);
    expect(retried).toEqual([{ i: 1, delaySeconds: 60 }]);
    expect(gh.calls.storage).toHaveLength(1);
    expect(
      (await artifact(firstId.releaseId, firstId.artifactId))?.locations_json,
    ).not.toBeNull();
    expect(
      (await artifact(secondId.releaseId, secondId.artifactId))?.locations_json,
    ).toBeNull();
    // Its hold still covers it: the backfill queues it again once the hold elapses.
    expect(await job(secondId.releaseId, secondId.artifactId)).toMatchObject({
      status: "queued",
    });
  });

  it("the consumer acks refusals and retries an unexpected throw", async () => {
    await sync();
    gh.corrupt.set(201, new Uint8Array(ASSET_BYTES[201]!.length));
    const { acked } = await drain();
    expect(acked).toHaveLength(4);
    expect(await job("v1.1.0", "201")).toMatchObject({ status: "failed" });

    const broken = {
      ...db,
      first: async () => {
        throw new Error("D1 down");
      },
    } as unknown as SqliteDb;
    const retried: number[] = [];
    await handleAssetQueue(
      {
        queue: "pkey-assets-test",
        messages: [
          {
            body: msg("v1.1.0", "201"),
            ack: () => undefined,
            retry: () => retried.push(0),
          },
        ],
      } as unknown as MessageBatch<unknown>,
      env,
      broken,
      gh.fetchImpl,
      () => NOW,
    );
    expect(retried).toEqual([0]);
  });
});
