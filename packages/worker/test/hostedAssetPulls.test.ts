/**
 * HA-05 — pull on register and resync (`core/hostedAssetPulls.ts`, `src/assetQueue.ts`,
 * `services/release/assetSource.ts`; notes/S-20 §6.3, §6.4).
 *
 * The three acceptance criteria of the brief are the first three `it`s under "re-sync semantics":
 * an unchanged manifest enqueues nothing; a changed icon URL swaps the copy only once the new
 * ingest is ready; a 404 leaves the old copy serving with status `stale`. The integration block
 * drives the real `linkRepo` → queue → `resyncRepo` path with a repo-path icon read through the
 * GitHub App installation token at the pinned commit.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ManifestDistribution } from "@polaris-key/manifest";
import {
  manifestAssetSlots,
  parseWantedRef,
  planHostedAssetPulls,
  processAssetPull,
  pullBackoffSeconds,
  PULL_BACKOFF_BASE_SECONDS,
  PULL_BACKOFF_CAP_SECONDS,
  readAssetLadderMessage,
  readAssetPullMessage,
  recheckHostedAssets,
  syncHostedAssets,
  wantedRefOf,
  type AssetPullMessage,
  type ManifestAssetSource,
  type RepoSourceResolver,
} from "../src/core/hostedAssetPulls.js";
import {
  HOSTED_ASSET_REF,
  parseVariants,
  type IngestContext,
} from "../src/core/hostedAssets.js";
import { blobKey } from "../src/core/blobs.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import { handleAssetQueue } from "../src/assetQueue.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { TEST_RSA_PKCS8 } from "./releaseFixtures.js";
import { HEAD_SHA, withDefaultHead } from "./githubHead.js";
import { linkRepo } from "../src/services/release/linkRepo.js";
import { resyncRepo } from "../src/services/release/resync.js";
import { manifestIngestFor } from "../src/core/registry.js";
import { SERVICES } from "../src/mount.js";
import { handleAdmin } from "../src/admin/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/admin/session.js";

beforeAll(() => installDigestStream());

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function png(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
}
const ICON_A = png(5_000, 3);
const ICON_B = png(6_000, 5);
const URL_A = "https://cdn.example.com/icon-a.png";
const URL_B = "https://cdn.example.com/icon-b.png";

const serve = (bytes: Uint8Array) => () =>
  new Response(bytes, {
    headers: { "content-length": String(bytes.length) },
  });

/** An upstream serving fixed bodies by URL (404 otherwise), counting calls. */
function upstream(
  routes: Record<string, () => Response>,
): FetchImpl & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push(url);
    const r = routes[url];
    return r ? r() : new Response("missing", { status: 404 });
  }) as FetchImpl & { calls: string[] };
  impl.calls = calls;
  return impl;
}

/** A queue that records what was sent. */
function fakeQueue() {
  const sent: AssetPullMessage[] = [];
  return {
    sent,
    queue: {
      async sendBatch(msgs: Iterable<{ body: unknown }>) {
        for (const m of msgs) sent.push(m.body as AssetPullMessage);
      },
      async send(body: unknown) {
        sent.push(body as AssetPullMessage);
      },
    } as unknown as Queue<unknown>,
  };
}

const iconManifest = (src: string): ManifestAssetSource => ({
  presentation: { icon: { kind: "url", src } },
});

const noRepo: RepoSourceResolver = async () => null;

let db: SqliteDb;
let r2: R2Mock;
let q: ReturnType<typeof fakeQueue>;
let env: Pick<Env, "BLOBS" | "HOSTED_ASSET_QUEUE" | "IMAGES">;

beforeEach(async () => {
  db = makeTestDb();
  r2 = new R2Mock();
  q = fakeQueue();
  env = { BLOBS: asR2(r2), HOSTED_ASSET_QUEUE: q.queue };
  await seedProduct(db, "djdl");
});

/** The whole row, HA-05's columns included. */
function row(product: string, slot: string) {
  return db.first<Record<string, unknown>>(
    "SELECT * FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ''",
    product,
    slot,
  );
}

function ctxAt(now: number, fetchImpl: FetchImpl): IngestContext {
  return { env, db, now, fetchImpl };
}

/** Sync `manifest` at `now`, then run every message it sent through the consumer. */
async function syncAndPull(
  manifest: ManifestAssetSource,
  now: number,
  fetchImpl: FetchImpl,
) {
  const before = q.sent.length;
  const res = await syncHostedAssets(env, db, {
    product: "djdl",
    manifest,
    commit: null,
    now,
  });
  const outcomes = [];
  for (const m of q.sent.slice(before))
    outcomes.push(await processAssetPull(ctxAt(now, fetchImpl), m, noRepo));
  return { ...res, outcomes };
}

// ── Slot planning ───────────────────────────────────────────────────────────────────────────

describe("manifestAssetSlots", () => {
  it("maps presentation and listing art to slots; the listing icon falls back to presentation", () => {
    const listing = {
      header: { kind: "url", src: "https://cdn.example.com/h.png" },
      screenshots: [
        { kind: "repo", src: "art/s1.png" },
        { kind: "url", src: "https://cdn.example.com/s2.png" },
      ],
    };
    const slots = manifestAssetSlots({
      presentation: { icon: { kind: "repo", src: "art/icon.png" } },
      distribution: { listing } as unknown as ManifestDistribution,
    });
    expect(slots.map((s) => [s.slot, s.ref.src, s.path])).toEqual([
      ["presentation.icon", "art/icon.png", "/presentation/icon"],
      ["listing.icon", "art/icon.png", "/presentation/icon"],
      ["listing.header", "https://cdn.example.com/h.png", "/listing/header"],
      ["listing.screenshot:1", "art/s1.png", "/listing/screenshots/0"],
      [
        "listing.screenshot:2",
        "https://cdn.example.com/s2.png",
        "/listing/screenshots/1",
      ],
    ]);
    const own = manifestAssetSlots({
      presentation: { icon: { kind: "url", src: URL_A } },
      distribution: {
        listing: { icon: { kind: "url", src: URL_B } },
      } as unknown as ManifestDistribution,
    });
    expect(own.find((s) => s.slot === "listing.icon")?.ref.src).toBe(URL_B);
    expect(manifestAssetSlots({})).toEqual([]);
  });

  it("spells a ref canonically and reads it back, refusing anything else", () => {
    const ref = { kind: "url" as const, src: URL_A, sha256: "a".repeat(64) };
    expect(parseWantedRef(wantedRefOf(ref))).toEqual(ref);
    expect(
      parseWantedRef(wantedRefOf({ kind: "repo", src: "a/b.png" })),
    ).toEqual({ kind: "repo", src: "a/b.png" });
    for (const bad of [
      null,
      "nope",
      '{"kind":"url","src":"http://x.example/a.png"}',
      '{"kind":"repo","src":"../a.png"}',
      '{"kind":"url","src":"https://x.example/a.png","sha256":"xyz"}',
    ])
      expect(parseWantedRef(bad)).toBeNull();
  });

  it("validates queue messages", () => {
    const ok: AssetPullMessage = {
      v: 1,
      product: "djdl",
      slot: "listing.screenshot:3",
      locale: "",
      wanted: wantedRefOf({ kind: "url", src: URL_A }),
      reason: "sync",
    };
    expect(readAssetPullMessage(ok)).toEqual(ok);
    expect(readAssetPullMessage({ ...ok, slot: "release-file" })).toBeNull();
    expect(readAssetPullMessage({ ...ok, product: "../x" })).toBeNull();
    expect(readAssetPullMessage({ ...ok, commit: "main" })).toBeNull();
    expect(readAssetPullMessage({ ...ok, v: 2 })).toBeNull();
    expect(readAssetPullMessage("x")).toBeNull();
  });

  it("backs off exponentially from 15 minutes, capped at a day", () => {
    expect(pullBackoffSeconds(1)).toBe(PULL_BACKOFF_BASE_SECONDS);
    expect(pullBackoffSeconds(2)).toBe(2 * PULL_BACKOFF_BASE_SECONDS);
    expect(pullBackoffSeconds(4)).toBe(8 * PULL_BACKOFF_BASE_SECONDS);
    expect(pullBackoffSeconds(7)).toBe(64 * PULL_BACKOFF_BASE_SECONDS);
    expect(pullBackoffSeconds(8)).toBe(PULL_BACKOFF_CAP_SECONDS);
    expect(pullBackoffSeconds(100)).toBe(PULL_BACKOFF_CAP_SECONDS);
  });
});

// ── Re-sync semantics (S-20 §6.4) ───────────────────────────────────────────────────────────

describe("re-sync semantics", () => {
  it("resyncing an unchanged manifest enqueues nothing", async () => {
    const up = upstream({ [URL_A]: serve(ICON_A) });
    const first = await syncAndPull(iconManifest(URL_A), NOW, up);
    // presentation.icon, and listing.icon falling back to it.
    expect(first.enqueued).toBe(2);
    expect(first.outcomes).toEqual(["ready", "ready"]);

    const sent = q.sent.length;
    for (const later of [NOW + 60, NOW + 7 * 86_400]) {
      const again = await syncHostedAssets(env, db, {
        product: "djdl",
        manifest: iconManifest(URL_A),
        commit: null,
        now: later,
      });
      expect(again).toEqual({ enqueued: 0, warnings: [] });
    }
    expect(q.sent.length).toBe(sent);
  });

  it("changing the icon URL swaps the copy only after the new ingest is ready", async () => {
    const up = upstream({ [URL_A]: serve(ICON_A), [URL_B]: serve(ICON_B) });
    await syncAndPull(iconManifest(URL_A), NOW, up);

    const before = q.sent.length;
    await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_B),
      commit: null,
      now: NOW + 100,
    });
    const msgs = q.sent.slice(before);
    expect(msgs.map((m) => m.slot).sort()).toEqual([
      "listing.icon",
      "presentation.icon",
    ]);

    // Enqueued, not yet pulled: the old copy still serves, ready, its refs intact.
    const pending = await row("djdl", "presentation.icon");
    expect(pending).toMatchObject({
      status: "ready",
      sha256: sha(ICON_A),
      source_ref: URL_A,
    });
    expect(
      await db.first(
        "SELECT 1 AS x FROM blob_refs WHERE product = 'djdl' AND storage_key = ? AND ref_kind = ?",
        blobKey(sha(ICON_A)),
        HOSTED_ASSET_REF,
      ),
    ).toEqual({ x: 1 });

    const view = await call("GET", "assets");
    expect(
      (view.json.assets as { slot: string; pullPending: boolean }[]).find(
        (a) => a.slot === "presentation.icon",
      ),
    ).toMatchObject({ pullPending: true, sha256: sha(ICON_A) });

    // The pull lands: the slot swaps to the new copy in one batch.
    const msg = msgs.find((m) => m.slot === "presentation.icon")!;
    expect(await processAssetPull(ctxAt(NOW + 101, up), msg, noRepo)).toBe(
      "ready",
    );
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      status: "ready",
      sha256: sha(ICON_B),
      source_ref: URL_B,
      pulled_ref: wantedRefOf({ kind: "url", src: URL_B }),
      attempts: 0,
      next_attempt_at: null,
    });
  });

  it("a 404 source leaves the old copy serving, with status stale", async () => {
    const up = upstream({ [URL_A]: serve(ICON_A) });
    await syncAndPull(iconManifest(URL_A), NOW, up);

    // The developer moves the icon to a URL that does not exist.
    const gone = "https://cdn.example.com/moved.png";
    const res = await syncAndPull(iconManifest(gone), NOW + 10, up);
    expect(res.outcomes).toEqual(["failed", "failed"]);
    const stale = await row("djdl", "presentation.icon");
    expect(stale).toMatchObject({
      status: "stale",
      error: "status:404",
      sha256: sha(ICON_A),
      source_ref: URL_A,
      attempts: 1,
      next_attempt_at: NOW + 10 + PULL_BACKOFF_BASE_SECONDS,
    });
    expect(await asR2(r2).head(blobKey(sha(ICON_A)))).not.toBeNull();

    // The next resync warns (never errors) and, inside the back-off, enqueues nothing.
    const sent = q.sent.length;
    const again = await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(gone),
      commit: null,
      now: NOW + 20,
    });
    expect(again.enqueued).toBe(0);
    expect(again.warnings).toEqual([
      expect.objectContaining({
        code: "asset_unreachable",
        document: "product",
        path: "/presentation/icon",
      }),
      expect.objectContaining({
        code: "asset_unreachable",
        path: "/presentation/icon",
      }),
    ]);
    expect(q.sent.length).toBe(sent);

    // Once the back-off elapses, the unchanged ref is pulled again; a second failure doubles it.
    const later = NOW + 10 + PULL_BACKOFF_BASE_SECONDS;
    const retry = await syncAndPull(iconManifest(gone), later, up);
    expect(retry.enqueued).toBe(2);
    expect(retry.outcomes).toEqual(["failed", "failed"]);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      status: "stale",
      sha256: sha(ICON_A),
      attempts: 2,
      next_attempt_at: later + 2 * PULL_BACKOFF_BASE_SECONDS,
    });
  });

  it("a first pull that fails leaves a failed row and nothing served", async () => {
    const res = await syncAndPull(
      iconManifest("https://cdn.example.com/none.png"),
      NOW,
      upstream({}),
    );
    expect(res.outcomes).toEqual(["failed", "failed"]);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      status: "failed",
      sha256: null,
      attempts: 1,
    });
  });

  it("never overwrites a console-claimed slot, but records what the manifest wants", async () => {
    await syncAndPull(
      iconManifest(URL_A),
      NOW,
      upstream({ [URL_A]: serve(ICON_A) }),
    );
    await db.run(
      "UPDATE hosted_assets SET origin = 'console', source_kind = 'upload' WHERE product = 'djdl' AND slot = 'presentation.icon'",
    );
    const before = q.sent.length;
    await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_B),
      commit: null,
      now: NOW + 5,
    });
    expect(q.sent.slice(before).map((m) => m.slot)).toEqual(["listing.icon"]);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      origin: "console",
      sha256: sha(ICON_A),
      wanted_ref: wantedRefOf({ kind: "url", src: URL_B }),
    });
    // A message already in flight for the slot is dropped on delivery.
    const stale: AssetPullMessage = {
      v: 1,
      product: "djdl",
      slot: "presentation.icon",
      locale: "",
      wanted: wantedRefOf({ kind: "url", src: URL_B }),
      reason: "sync",
    };
    expect(
      await processAssetPull(
        ctxAt(NOW + 6, upstream({ [URL_B]: serve(ICON_B) })),
        stale,
        noRepo,
      ),
    ).toBe("superseded");
  });

  it("drops a message a later resync superseded", async () => {
    const up = upstream({ [URL_A]: serve(ICON_A), [URL_B]: serve(ICON_B) });
    await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_A),
      commit: null,
      now: NOW,
    });
    const first = q.sent.find((m) => m.slot === "presentation.icon")!;
    await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_B),
      commit: null,
      now: NOW + 1,
    });
    expect(await processAssetPull(ctxAt(NOW + 2, up), first, noRepo)).toBe(
      "superseded",
    );
    expect(up.calls).toEqual([]);
  });

  it("a slot the manifest stops declaring loses its row and refs", async () => {
    await syncAndPull(
      iconManifest(URL_A),
      NOW,
      upstream({ [URL_A]: serve(ICON_A) }),
    );
    const res = await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: {},
      commit: null,
      now: NOW + 5,
    });
    expect(res.enqueued).toBe(0);
    expect(await db.all("SELECT slot FROM hosted_assets")).toEqual([]);
    expect(
      await db.all(
        "SELECT ref_id FROM blob_refs WHERE product = 'djdl' AND ref_kind = ?",
        HOSTED_ASSET_REF,
      ),
    ).toEqual([]);
  });

  it("plans nothing without a queue binding, and never throws into the apply", async () => {
    const res = await syncHostedAssets({}, db, {
      product: "djdl",
      manifest: iconManifest(URL_A),
      commit: null,
      now: NOW,
    });
    expect(res).toEqual({ enqueued: 0, warnings: [] });
    expect(await db.all("SELECT slot FROM hosted_assets")).toEqual([]);

    const broken = {
      HOSTED_ASSET_QUEUE: {
        async sendBatch() {
          throw new Error("queue down");
        },
      } as unknown as Queue<unknown>,
    };
    const down = await syncHostedAssets(broken, db, {
      product: "djdl",
      manifest: iconManifest(URL_A),
      commit: null,
      now: NOW,
    });
    expect(down.enqueued).toBe(0);
    // The rows record the owed pulls; the nightly re-check sends them.
    expect(
      (await db.all("SELECT slot FROM hosted_assets ORDER BY slot")).length,
    ).toBe(2);
  });

  it("repo refs are skipped without a commit to read them at", async () => {
    const plan = await planHostedAssetPulls(db, {
      product: "djdl",
      manifest: { presentation: { icon: { kind: "repo", src: "art/i.png" } } },
      commit: null,
      now: NOW,
    });
    expect(plan.messages).toEqual([]);
    expect(plan.statements).toEqual([]);
  });
});

// ── Nightly re-check ───────────────────────────────────────────────────────────────────────

describe("recheckHostedAssets", () => {
  it("re-enqueues owed pulls whose back-off elapsed, bounded per run", async () => {
    await syncAndPull(
      iconManifest("https://cdn.example.com/none.png"),
      NOW,
      upstream({}),
    );
    const before = q.sent.length;
    // Inside the back-off: nothing.
    expect(await recheckHostedAssets(env, db, NOW + 60)).toBe(0);
    // After it: both slots, or as many as the bound allows.
    const later = NOW + PULL_BACKOFF_BASE_SECONDS + 1;
    expect(await recheckHostedAssets(env, db, later, 1)).toBe(1);
    expect(await recheckHostedAssets(env, db, later, 10)).toBe(1);
    expect(q.sent.slice(before).map((m) => m.reason)).toEqual([
      "recheck",
      "recheck",
    ]);
    // Each enqueue holds off the next one for a back-off step.
    expect(await recheckHostedAssets(env, db, later + 1, 10)).toBe(0);
    expect(await recheckHostedAssets({}, db, later + 10_000)).toBe(0);
  });

  it("leaves ready, console and deleted-product rows alone", async () => {
    await syncAndPull(
      iconManifest(URL_A),
      NOW,
      upstream({ [URL_A]: serve(ICON_A) }),
    );
    expect(await recheckHostedAssets(env, db, NOW + 10 * 86_400)).toBe(0);
  });
});

// ── Owed ladders (HA-03's fallback, retried) ────────────────────────────────────────────────

/**
 * A stub Images binding: `.info()` answers `width`; each transformation answers a fake WebP of the
 * source and width, or throws error 9422 while `quota` is set. `made` records every width made.
 */
function images(width: number) {
  const made: number[] = [];
  const state = { quota: false, made };
  const binding = {
    info: async (s: ReadableStream<Uint8Array>) => {
      await new Response(s).arrayBuffer();
      return { format: "image/png", fileSize: 1, width, height: width };
    },
    input: (s: ReadableStream<Uint8Array>) => {
      let w = 0;
      const t = {
        transform(tr: { width: number }) {
          w = tr.width;
          return t;
        },
        async output() {
          const src = new Uint8Array(await new Response(s).arrayBuffer());
          if (state.quota)
            throw Object.assign(new Error("ERROR 9422"), { code: 9422 });
          made.push(w);
          const out = png(200 + w, w * 31 + src.length);
          out.set([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4], 0);
          out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], 8);
          return { image: () => new Response(out).body! };
        },
      };
      return t;
    },
  };
  return { binding: binding as unknown as ImagesBinding, state };
}

function ladderOf(product: string, slot: string, locale = "") {
  return db
    .first<{
      variants_json: string | null;
    }>(
      "SELECT variants_json FROM hosted_assets WHERE product = ? AND slot = ? AND locale = ?",
      product,
      slot,
      locale,
    )
    .then((r) => parseVariants(r?.variants_json ?? null));
}

/** Run `msgs` through the real consumer at `now`; every pull fetches through `up`. */
async function consume(
  msgs: readonly unknown[],
  now: number,
  up: FetchImpl,
): Promise<{ acked: number[]; retried: number[] }> {
  const acked: number[] = [];
  const retried: number[] = [];
  await handleAssetQueue(
    {
      queue: "pkey-assets-test",
      messages: msgs.map((body, i) => ({
        body,
        ack: () => acked.push(i),
        retry: () => retried.push(i),
      })),
    } as unknown as MessageBatch<unknown>,
    env as Env,
    db,
    up,
    () => now,
  );
  return { acked, retried };
}

describe("owed ladders", () => {
  it("a 9422 at ingest leaves the copy owing its ladder; the re-check rebuilds only the ladder, with back-off", async () => {
    const img = images(512);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    const up = upstream({ [URL_A]: serve(ICON_A) });
    const first = await syncAndPull(iconManifest(URL_A), NOW, up);
    expect(first.outcomes).toEqual(["ready", "ready"]);
    expect(up.calls).toHaveLength(2);
    // Both copies serve, with no sizes; the ingest's failure is the ladder's first attempt.
    for (const slot of ["presentation.icon", "listing.icon"])
      expect(await row("djdl", slot)).toMatchObject({
        status: "ready",
        sha256: sha(ICON_A),
        variants_json: "[]",
        attempts: 1,
        next_attempt_at: NOW + PULL_BACKOFF_BASE_SECONDS,
      });

    // Inside the back-off: neither a resync nor the re-check sends anything.
    const sent = q.sent.length;
    expect(
      await syncHostedAssets(env, db, {
        product: "djdl",
        manifest: iconManifest(URL_A),
        commit: null,
        now: NOW + 60,
      }),
    ).toEqual({ enqueued: 0, warnings: [] });
    expect(await recheckHostedAssets(env, db, NOW + 60)).toBe(0);
    expect(q.sent.length).toBe(sent);

    // Still over quota at the next step: one ladder retry per slot, each failing again.
    const t1 = NOW + PULL_BACKOFF_BASE_SECONDS;
    expect(await recheckHostedAssets(env, db, t1)).toBe(2);
    const retries = q.sent.slice(sent) as unknown[];
    expect(retries).toEqual([
      {
        v: 1,
        kind: "ladder",
        product: "djdl",
        slot: "listing.icon",
        locale: "",
        sha256: sha(ICON_A),
        reason: "recheck",
      },
      expect.objectContaining({ kind: "ladder", slot: "presentation.icon" }),
    ]);
    expect(await consume(retries, t1, up)).toEqual({
      acked: [0, 1],
      retried: [],
    });
    expect(up.calls).toHaveLength(2); // never re-pulled
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      variants_json: "[]",
      attempts: 2,
      next_attempt_at: t1 + 2 * PULL_BACKOFF_BASE_SECONDS,
    });

    // The quota is back: the next retry builds the ladder once, and the second slot reuses it.
    img.state.quota = false;
    const t2 = t1 + 2 * PULL_BACKOFF_BASE_SECONDS;
    const before = q.sent.length;
    expect(await recheckHostedAssets(env, db, t2)).toBe(2);
    await consume(q.sent.slice(before), t2, up);
    expect(up.calls).toHaveLength(2);
    expect(img.state.made).toEqual([64, 128, 256, 512]);
    const ladder = await ladderOf("djdl", "presentation.icon");
    expect(ladder.map((v) => v.w)).toEqual([64, 128, 256, 512]);
    expect(await ladderOf("djdl", "listing.icon")).toEqual(ladder);
    for (const slot of ["presentation.icon", "listing.icon"])
      expect(await row("djdl", slot)).toMatchObject({
        sha256: sha(ICON_A),
        attempts: 0,
        next_attempt_at: null,
      });
    // Owed no more: nothing to re-check, ever.
    expect(await recheckHostedAssets(env, db, t2 + 30 * 86_400)).toBe(0);
  });

  it("the back-off doubles per failed retry and is capped at a day", async () => {
    const img = images(512);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    await syncAndPull(
      iconManifest(URL_A),
      NOW,
      upstream({ [URL_A]: serve(ICON_A) }),
    );
    await db.run(
      "UPDATE hosted_assets SET attempts = 9, next_attempt_at = NULL WHERE slot = 'listing.icon'",
    );
    const before = q.sent.length;
    expect(await recheckHostedAssets(env, db, NOW + 5, 1)).toBe(1);
    await consume(q.sent.slice(before), NOW + 5, upstream({}));
    expect(await row("djdl", "listing.icon")).toMatchObject({
      attempts: 10,
      next_attempt_at: NOW + 5 + PULL_BACKOFF_CAP_SECONDS,
    });
  });

  it("a resync retries an owed ladder once the back-off has elapsed, and never re-pulls", async () => {
    const img = images(300);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    const up = upstream({ [URL_A]: serve(ICON_A) });
    await syncAndPull(iconManifest(URL_A), NOW, up);
    img.state.quota = false;
    const before = q.sent.length;
    const t = NOW + PULL_BACKOFF_BASE_SECONDS;
    const res = await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_A),
      commit: null,
      now: t,
    });
    expect(res).toEqual({ enqueued: 2, warnings: [] });
    const msgs = q.sent.slice(before) as unknown[];
    expect(msgs).toEqual([
      expect.objectContaining({
        kind: "ladder",
        slot: "presentation.icon",
        reason: "sync",
      }),
      expect.objectContaining({
        kind: "ladder",
        slot: "listing.icon",
        reason: "sync",
      }),
    ]);
    // Each message holds its slot off for a back-off step: an immediate resync sends nothing.
    expect(
      (
        await syncHostedAssets(env, db, {
          product: "djdl",
          manifest: iconManifest(URL_A),
          commit: null,
          now: t + 1,
        })
      ).enqueued,
    ).toBe(0);
    await consume(msgs, t + 2, up);
    expect(up.calls).toHaveLength(2);
    expect(img.state.made).toEqual([64, 128, 256]);
    expect((await ladderOf("djdl", "listing.icon")).map((v) => v.w)).toEqual([
      64, 128, 256,
    ]);
  });

  it("a changed ref pulls instead: the pull's ingest builds the ladder", async () => {
    const img = images(300);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    const up = upstream({ [URL_A]: serve(ICON_A), [URL_B]: serve(ICON_B) });
    await syncAndPull(iconManifest(URL_A), NOW, up);
    img.state.quota = false;
    const res = await syncAndPull(
      iconManifest(URL_B),
      NOW + PULL_BACKOFF_BASE_SECONDS,
      up,
    );
    expect(res.outcomes).toEqual(["ready", "ready"]);
    expect(q.sent.some((m) => "kind" in m)).toBe(false);
    expect(
      (await ladderOf("djdl", "presentation.icon")).map((v) => v.w),
    ).toEqual([64, 128, 256]);
    expect(img.state.made).toEqual([64, 128, 256]);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      sha256: sha(ICON_B),
      attempts: 0,
      next_attempt_at: null,
    });
  });

  it("retries nothing without the binding, for a slot without a ladder, or below the smallest rung", async () => {
    // No binding: the copies have no width and no sizes, and nothing is ever retried.
    const up = upstream({ [URL_A]: serve(ICON_A) });
    await syncAndPull(iconManifest(URL_A), NOW, up);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      variants_json: "[]",
      width: null,
      attempts: 0,
      next_attempt_at: null,
    });
    const sent = q.sent.length;
    expect(await recheckHostedAssets(env, db, NOW + 30 * 86_400)).toBe(0);
    expect(
      (
        await syncHostedAssets(env, db, {
          product: "djdl",
          manifest: iconManifest(URL_A),
          commit: null,
          now: NOW + 30 * 86_400,
        })
      ).enqueued,
    ).toBe(0);
    // A ladder message that arrives anyway does nothing without the binding.
    const msg = {
      v: 1,
      kind: "ladder",
      product: "djdl",
      slot: "presentation.icon",
      locale: "",
      sha256: sha(ICON_A),
      reason: "recheck",
    };
    expect(await consume([msg], NOW + 1, up)).toEqual({
      acked: [0],
      retried: [],
    });
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      variants_json: "[]",
      attempts: 0,
    });

    // With the binding: a slot without a ladder family, and an icon narrower than 64 px, owe
    // nothing. The icon whose width was never learned does.
    env = { ...env, IMAGES: images(48).binding };
    for (const slot of ["play:icon", "notes-image:0123456789abcdef"])
      await db.run(
        `INSERT INTO hosted_assets (product, slot, locale, origin, source_kind, sha256, width,
           variants_json, status, modified_at)
         VALUES ('djdl', ?, '', 'console', 'upload', ?, 4000, '[]', 'ready', ?)`,
        slot,
        sha(ICON_A),
        NOW,
      );
    await db.run(
      "UPDATE hosted_assets SET width = 48 WHERE slot = 'listing.icon'",
    );
    const t = NOW + 30 * 86_400;
    expect(await recheckHostedAssets(env, db, t)).toBe(1);
    expect(q.sent.slice(sent)).toEqual([
      expect.objectContaining({ kind: "ladder", slot: "presentation.icon" }),
    ]);
    // Its retry learns the width (48 px admits no rung): recorded, and owed no more.
    await consume(q.sent.slice(sent), t, up);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      width: 48,
      variants_json: "[]",
      attempts: 0,
      next_attempt_at: null,
    });
    expect(await recheckHostedAssets(env, db, t + 30 * 86_400)).toBe(0);
  });

  it("pulls and ladders share the re-check's budget, oldest-due first", async () => {
    const img = images(512);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    await syncAndPull(
      iconManifest(URL_A),
      NOW,
      upstream({ [URL_A]: serve(ICON_A) }),
    );
    // listing.icon now owes a pull instead (a ref that failed), due earlier than the ladder.
    await db.run(
      `UPDATE hosted_assets SET wanted_ref = ?, status = 'failed', next_attempt_at = ?
        WHERE slot = 'listing.icon'`,
      wantedRefOf({ kind: "url", src: URL_B }),
      NOW + 10,
    );
    const t = NOW + PULL_BACKOFF_BASE_SECONDS;
    const before = q.sent.length;
    expect(await recheckHostedAssets(env, db, t, 1)).toBe(1);
    expect(await recheckHostedAssets(env, db, t, 1)).toBe(1);
    expect(await recheckHostedAssets(env, db, t, 1)).toBe(0);
    expect(q.sent.slice(before)).toEqual([
      expect.objectContaining({ slot: "listing.icon", reason: "recheck" }),
      expect.objectContaining({ slot: "presentation.icon", kind: "ladder" }),
    ]);
    expect("kind" in q.sent[before]!).toBe(false);
  });

  it("drops a ladder message for bytes the slot no longer holds", async () => {
    const img = images(512);
    env = { ...env, IMAGES: img.binding };
    img.state.quota = true;
    const up = upstream({ [URL_A]: serve(ICON_A), [URL_B]: serve(ICON_B) });
    await syncAndPull(iconManifest(URL_A), NOW, up);
    const t = NOW + PULL_BACKOFF_BASE_SECONDS;
    const before = q.sent.length;
    expect(await recheckHostedAssets(env, db, t)).toBe(2);
    const stale = q.sent.slice(before);
    // A new icon lands first (its ladder fails too).
    await syncAndPull(iconManifest(URL_B), t + 1, up);
    img.state.quota = false;
    await consume(stale, t + 2, up);
    expect(img.state.made).toEqual([]);
    expect(await row("djdl", "presentation.icon")).toMatchObject({
      sha256: sha(ICON_B),
      variants_json: "[]",
      attempts: 1,
      next_attempt_at: t + 1 + PULL_BACKOFF_BASE_SECONDS,
    });
  });

  it("validates ladder messages, and never reads one as a pull", () => {
    const ok = {
      v: 1,
      kind: "ladder",
      product: "djdl",
      slot: "listing.screenshot:16",
      locale: "de-AT",
      sha256: "a".repeat(64),
      reason: "recheck",
    };
    expect(readAssetLadderMessage(ok)).toEqual(ok);
    expect(readAssetPullMessage(ok)).toBeNull();
    expect(readAssetPullMessage({ ...ok, wanted: "{}" })).toBeNull();
    for (const bad of [
      { ...ok, kind: "pull" },
      { ...ok, slot: "play:icon" },
      { ...ok, slot: "listing.screenshot:17" },
      { ...ok, locale: "../x" },
      { ...ok, sha256: "A".repeat(64) },
      { ...ok, reason: "operator" },
      { ...ok, product: "../x" },
      { ...ok, v: 2 },
    ])
      expect(readAssetLadderMessage(bad), JSON.stringify(bad)).toBeNull();
    expect(
      readAssetLadderMessage({
        v: 1,
        product: "djdl",
        slot: "presentation.icon",
        locale: "",
        wanted: "{}",
        reason: "sync",
      }),
    ).toBeNull();
  });
});

// ── The consumer ───────────────────────────────────────────────────────────────────────────

describe("handleAssetQueue", () => {
  function batch(queue: string, bodies: unknown[]) {
    const acked: number[] = [];
    const retried: number[] = [];
    return {
      acked,
      retried,
      batch: {
        queue,
        messages: bodies.map((body, i) => ({
          id: String(i),
          timestamp: new Date(),
          attempts: 1,
          body,
          ack: () => acked.push(i),
          retry: () => retried.push(i),
        })),
        ackAll() {},
        retryAll() {},
      } as unknown as MessageBatch<unknown>,
    };
  }

  it("acks refused and malformed messages, and retries an unexpected throw", async () => {
    await syncHostedAssets(env, db, {
      product: "djdl",
      manifest: iconManifest(URL_A),
      commit: null,
      now: NOW,
    });
    const good = q.sent[0]!;
    const b = batch("pkey-assets-dev", [good, { nope: 1 }]);
    await handleAssetQueue(
      b.batch,
      env as Env,
      db,
      upstream({ [URL_A]: serve(ICON_A) }),
      () => NOW + 1,
    );
    expect(b.acked).toEqual([0, 1]);
    expect(await row("djdl", good.slot)).toMatchObject({
      status: "ready",
    });

    const broken = {
      ...db,
      first: async () => {
        throw new Error("D1 down");
      },
    } as unknown as SqliteDb;
    const c = batch("pkey-assets-dev", [good]);
    await handleAssetQueue(
      c.batch,
      env as Env,
      broken,
      upstream({}),
      () => NOW,
    );
    expect(c.retried).toEqual([0]);
  });
});

// ── Integration: link → queue → resync, with a repo-path icon ───────────────────────────────

const SLUG = "acme";
const ICON_PATH = "art/icon.png";
const BLOB_1 = "1".repeat(40);
const BLOB_2 = "2".repeat(40);
const ADMIN_SECRET = "test-admin-session-secret";
const PLATFORM_GROUP = "platform-admins";

const PRODUCT_JSON = JSON.stringify({
  slug: SLUG,
  name: "Acme",
  compatMin: "1.0.0",
  compatMax: "9.0.0",
  defaultMaxOfflineDays: 14,
  defaultDeviceLimit: 3,
  adminGroup: "acme-admins",
  profiles: [{ id: "standard", name: "standard" }],
  tiers: [{ id: "standard", label: "Standard", profileId: "standard" }],
  provisioning: [],
  presentation: { icon: `./${ICON_PATH}` },
});
const RELEASE_JSON = JSON.stringify({
  release: {
    ghOwner: "acme-org",
    ghRepo: "acme-app",
    binaryName: "acme",
    betaBranch: "main",
    summaryMarker: "pkey:summary",
  },
});

interface RepoState {
  head: string;
  blob: string;
  bytes: Uint8Array;
  calls: string[];
}

/** GitHub, stubbed: the App, `.pkey/`, the `art/` listing and the raw icon at the head commit. */
function github(state: RepoState): FetchImpl {
  const files: Record<string, string> = {
    ".pkey/schema.json": JSON.stringify({ schemaVersion: 1, entries: [] }),
    ".pkey/product.json": PRODUCT_JSON,
    ".pkey/release.json": RELEASE_JSON,
  };
  const inner = async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    state.calls.push(url);
    if (url.includes("/access_tokens"))
      return new Response(JSON.stringify({ token: "ghs_token" }), {
        status: 200,
      });
    if (url.includes("/installation"))
      return new Response(JSON.stringify({ id: 4242 }), { status: 200 });
    const base = "https://api.github.com/repos/acme-org/acme-app/contents";
    if (url === `${base}/art?ref=${state.head}`)
      return new Response(
        JSON.stringify([
          { type: "file", path: ICON_PATH, sha: state.blob },
          { type: "file", path: "art/other.png", sha: "9".repeat(40) },
        ]),
        { status: 200 },
      );
    if (url === `${base}/${ICON_PATH}?ref=${state.head}`) {
      const h = new Headers(
        typeof input === "string" ? init?.headers : input.headers,
      );
      if (
        h.get("accept") !== "application/vnd.github.raw+json" ||
        h.get("authorization") !== "Bearer ghs_token"
      )
        return new Response("bad request", { status: 400 });
      return serve(state.bytes)();
    }
    if (url.includes("/contents/")) {
      for (const [path, body] of Object.entries(files))
        if (url.includes(`/contents/${path}`))
          return new Response(
            JSON.stringify({
              content: Buffer.from(body, "utf8").toString("base64"),
              encoding: "base64",
            }),
            { status: 200 },
          );
      return new Response("not found", { status: 404 });
    }
    if (url.includes("/releases?per_page"))
      return new Response("[]", { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return withDefaultHead(inner as never, () => state.head) as FetchImpl;
}

function repoEnv(): Env {
  const e = makeEnv(new KvMock(), []);
  e.GITHUB_APP_ID = "12345";
  e.GITHUB_APP_PRIVATE_KEY = TEST_RSA_PKCS8;
  e.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  e.BLOBS = asR2(r2);
  e.HOSTED_ASSET_QUEUE = q.queue;
  return e;
}

async function drain(e: Env, fetchImpl: FetchImpl, now: number, from: number) {
  const bodies = q.sent.slice(from);
  const acked: number[] = [];
  await handleAssetQueue(
    {
      queue: "pkey-assets-test",
      messages: bodies.map((body, i) => ({
        body,
        ack: () => acked.push(i),
        retry: () => undefined,
      })),
    } as unknown as MessageBatch<unknown>,
    e,
    db,
    fetchImpl,
    () => now,
  );
  return bodies;
}

describe("link and resync with a repo-path icon", () => {
  it("pulls at the pinned commit through the installation token; a new commit pulls only a changed blob", async () => {
    const e = repoEnv();
    const state: RepoState = {
      head: HEAD_SHA,
      blob: BLOB_1,
      bytes: ICON_A,
      calls: [],
    };
    const gh = github(state);
    const link = await linkRepo(
      e,
      db,
      "acme-org/acme-app",
      NOW,
      gh,
      manifestIngestFor(SERVICES),
    );
    expect(link.ok).toBe(true);
    expect(q.sent.map((m) => [m.slot, m.commit, m.blob])).toEqual([
      ["presentation.icon", HEAD_SHA, BLOB_1],
      ["listing.icon", HEAD_SHA, BLOB_1],
    ]);
    await drain(e, gh, NOW + 1, 0);
    expect(await row(SLUG, "presentation.icon")).toMatchObject({
      status: "ready",
      origin: "manifest",
      source_kind: "repo",
      source_ref: `${ICON_PATH}@${HEAD_SHA}`,
      source_blob: BLOB_1,
      sha256: sha(ICON_A),
      content_type: "image/png",
    });

    // The same commit: nothing enqueued, no listing read.
    let sent = q.sent.length;
    state.calls.length = 0;
    const same = await resyncRepo(e, db, SLUG, NOW + 10, gh);
    expect(same.ok).toBe(true);
    expect(q.sent.length).toBe(sent);
    expect(state.calls.some((u) => u.includes("/contents/art?"))).toBe(false);

    // A new commit that leaves the icon alone: one listing read, nothing enqueued.
    state.head = "a".repeat(40);
    const moved = await resyncRepo(e, db, SLUG, NOW + 20, gh);
    expect(moved.ok).toBe(true);
    expect(q.sent.length).toBe(sent);
    expect(state.calls.filter((u) => u.includes("/contents/art?")).length).toBe(
      1,
    );
    expect((await row(SLUG, "presentation.icon"))?.source_ref).toBe(
      `${ICON_PATH}@${"a".repeat(40)}`,
    );

    // A new commit that changes the icon: both slots pull the new blob, the old copy serving
    // until each lands.
    state.head = "b".repeat(40);
    state.blob = BLOB_2;
    state.bytes = ICON_B;
    sent = q.sent.length;
    const changed = await resyncRepo(e, db, SLUG, NOW + 30, gh);
    expect(changed.ok && changed.updated).toContain("assets");
    expect(q.sent.slice(sent).map((m) => [m.slot, m.blob])).toEqual([
      ["presentation.icon", BLOB_2],
      ["listing.icon", BLOB_2],
    ]);
    expect((await row(SLUG, "presentation.icon"))?.sha256).toBe(sha(ICON_A));
    await drain(e, gh, NOW + 31, sent);
    expect(await row(SLUG, "presentation.icon")).toMatchObject({
      sha256: sha(ICON_B),
      source_blob: BLOB_2,
      source_ref: `${ICON_PATH}@${"b".repeat(40)}`,
    });
  });

  it("a resync reports a failing asset as asset_unreachable and still applies", async () => {
    const e = repoEnv();
    const state: RepoState = {
      head: HEAD_SHA,
      blob: BLOB_1,
      bytes: ICON_A,
      calls: [],
    };
    const gh = github(state);
    expect(
      (
        await linkRepo(
          e,
          db,
          "acme-org/acme-app",
          NOW,
          gh,
          manifestIngestFor(SERVICES),
        )
      ).ok,
    ).toBe(true);
    // The file is not an image: refused, nothing served.
    state.bytes = new TextEncoder().encode("<svg></svg>");
    await drain(e, gh, NOW + 1, 0);
    const res = await resyncRepo(e, db, SLUG, NOW + 2, gh);
    expect(res.ok).toBe(true);
    expect(res.ok && res.warnings?.map((w) => [w.code, w.path])).toEqual([
      ["asset_unreachable", "/presentation/icon"],
      ["asset_unreachable", "/presentation/icon"],
    ]);
  });
});

// ── The console read ───────────────────────────────────────────────────────────────────────

async function call(method: string, path: string) {
  const e = makeEnv(new KvMock(), []);
  e.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  e.PLATFORM_ADMIN_GROUP = PLATFORM_GROUP;
  const { token } = await issueSession(
    e,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [PLATFORM_GROUP] },
    NOW,
  );
  const full = `/api/products/djdl/${path}`;
  const res = await handleAdmin(
    new Request(`https://key.plrs.im/manage${full}`, {
      method,
      headers: { cookie: `${ADMIN_COOKIE}=${token}` },
    }),
    e,
    db,
    full,
    { now: NOW },
  );
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe("GET /manage/api/products/:p/assets", () => {
  it("lists the product's hosted assets with their status and owed pulls", async () => {
    await syncAndPull(
      iconManifest("https://cdn.example.com/none.png"),
      NOW,
      upstream({}),
    );
    const res = await call("GET", "assets");
    expect(res.status).toBe(200);
    const assets = res.json.assets as Record<string, unknown>[];
    expect(assets.map((a) => a.slot)).toEqual([
      "listing.icon",
      "presentation.icon",
    ]);
    expect(assets[1]).toMatchObject({
      origin: "manifest",
      sourceKind: "url",
      status: "failed",
      error: "status:404",
      sha256: null,
      wanted: { kind: "url", src: "https://cdn.example.com/none.png" },
      pullPending: true,
      attempts: 1,
    });
  });

  it("is read-only as a list; a slot takes only HA-06's POST and DELETE", async () => {
    expect((await call("POST", "assets")).status).toBe(403); // CSRF first
    expect((await call("GET", "assets/x")).status).toBe(405);
    expect((await call("GET", "assets/a/b")).status).toBe(404);
  });
});

// ── Bindings ───────────────────────────────────────────────────────────────────────────────

describe("wrangler.toml", () => {
  it("binds pkey-assets-<env> per environment: producer and consumer here, with its DLQ", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const main = readFileSync(join(here, "..", "wrangler.toml"), "utf8");
    for (const env of ["prod", "staging", "dev"]) {
      expect(main).toMatch(
        new RegExp(
          `\\[\\[env\\.${env}\\.queues\\.producers\\]\\]\\nbinding = "HOSTED_ASSET_QUEUE"\\nqueue = "pkey-assets-${env}"`,
        ),
      );
      expect(main).toMatch(
        new RegExp(
          `\\[\\[env\\.${env}\\.queues\\.consumers\\]\\]\\nqueue = "pkey-assets-${env}"\\n[^[]*dead_letter_queue = "pkey-assets-dlq-${env}"`,
        ),
      );
    }
  });
});
