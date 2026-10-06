/**
 * HA-06 — files that are not on the web (`core/hostedAssetUploads.ts`, `admin/handlers/
 * hostedAssets.ts`, `services/distribution/listing/hostedMirror.ts`; notes/S-20 §6.3, owner
 * decision 11).
 *
 * The brief's two behavioural acceptance criteria lead: an uploaded icon survives a resync and
 * Revert restores the manifest's copy; a CI push never overwrites a console claim. Then the console
 * routes (caps, refusals that leave the slot alone, delete-a-copy, the list's new fields), the CI
 * route (scope, ticket, precedence, the listing model's `import` rows), the in-batch precedence
 * guard, and the image header reader.
 */

import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tokens = vi.hoisted(
  () =>
    new Map<
      string,
      {
        product: string;
        subject: string;
        scopes: readonly string[];
        tokenHash: string;
        expiresAt: number;
      }
    >(),
);
vi.mock("../src/core/ciTokens.js", () => ({
  lookupCiToken: async (_env: unknown, _db: unknown, token: string) =>
    tokens.get(token) ?? null,
}));

import {
  planHostedAssetPulls,
  processAssetPull,
  syncHostedAssets,
  type AssetPullMessage,
  type ManifestAssetSource,
  type RepoSourceResolver,
} from "../src/core/hostedAssetPulls.js";
import {
  getHostedAsset,
  HOSTED_ASSET_REF,
  ingest,
  type IngestContext,
} from "../src/core/hostedAssets.js";
import {
  imageHeaderInfo,
  isListingModelSlot,
  isUploadSlot,
  uploadSlotMaxBytes,
} from "../src/core/hostedAssetUploads.js";
import { blobKey, putVerified, stagingKey } from "../src/core/blobs.js";
import { issueUploadTicket } from "../src/core/publisher.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import type { Db } from "../src/db/types.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import type { Env } from "../src/env.js";
import { dispatch } from "../src/dispatch.js";
import { handleAdmin } from "../src/admin/index.js";
import { ADMIN_COOKIE, issueSession } from "../src/admin/session.js";
import { makeTestDb } from "./helpers.js";
import { KvMock } from "./kvMock.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { makeEnv, NOW, seedProduct } from "./seed.js";
import { enableServices } from "./releaseRoutesFixture.js";

beforeAll(() => installDigestStream());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const SLUG = "djdl";
const IMG = "https://img.test";
const CONSOLE = "https://key.example.test";
const PUSHER = "pkeyci_pusher";
const LISTER = "pkeyci_lister";
const ADMIN_GROUP = "platform-admins";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A PNG: a real IHDR (so the header reader has something to read), then seeded noise. */
function png(
  n: number,
  seed: number,
  w = 512,
  h = 512,
  colour = 6,
): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  out.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  const dv = new DataView(out.buffer);
  dv.setUint32(16, w);
  dv.setUint32(20, h);
  out.set([8, colour, 0, 0, 0], 24);
  // The next chunk header: a length that runs past the buffer, so no tRNS is "found".
  out.set([0x7f, 0xff, 0xff, 0xff, 0x49, 0x44, 0x41, 0x54], 33);
  return out;
}

const ICON_A = png(5_000, 3);
const ICON_B = png(6_000, 5);
const ICON_C = png(7_000, 7, 256, 256, 2);
const URL_A = "https://cdn.example.com/icon-a.png";
const URL_B = "https://cdn.example.com/icon-b.png";

function upstream(routes: Record<string, Uint8Array>): FetchImpl {
  return (async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    const body = routes[url];
    return body
      ? new Response(body, {
          headers: { "content-length": String(body.length) },
        })
      : new Response("missing", { status: 404 });
  }) as FetchImpl;
}

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

const noRepo: RepoSourceResolver = async () => null;
const iconManifest = (src: string): ManifestAssetSource => ({
  presentation: { icon: { kind: "url", src } },
});

let db: SqliteDb;
let r2: R2Mock;
let q: ReturnType<typeof fakeQueue>;
let env: Env;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW * 1000 });
  tokens.clear();
  tokens.set(PUSHER, {
    product: SLUG,
    subject: "static:tok_assets",
    scopes: ["assets:write"],
    tokenHash: "hash-pusher",
    expiresAt: NOW + 3600,
  });
  tokens.set(LISTER, {
    product: SLUG,
    subject: "static:tok_listing",
    scopes: ["distribution:listing"],
    tokenHash: "hash-lister",
    expiresAt: NOW + 3600,
  });
  db = makeTestDb();
  r2 = new R2Mock();
  q = fakeQueue();
  env = makeEnv(new KvMock(), []);
  env.ADMIN_SESSION_SECRET = "test-admin-session-secret";
  env.PLATFORM_ADMIN_GROUP = ADMIN_GROUP;
  env.IMG_ORIGIN = IMG;
  env.BLOBS = asR2(r2);
  env.HOSTED_ASSET_QUEUE = q.queue;
  await seedProduct(db, SLUG);
});

function ctx(fetchImpl?: FetchImpl): IngestContext {
  return { env, db, now: NOW, ...(fetchImpl ? { fetchImpl } : {}) };
}

/** A console request (session cookie + CSRF) through the real admin dispatcher. */
async function admin(
  method: string,
  path: string,
  body?: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  const { token, session } = await issueSession(
    env,
    { sub: "u1", name: "Ada", email: "ada@x.io", groups: [ADMIN_GROUP] },
    NOW,
  );
  const url = `${CONSOLE}/manage${path}`;
  return handleAdmin(
    new Request(url, {
      method,
      headers: {
        cookie: `${ADMIN_COOKIE}=${token}`,
        "x-pkey-csrf": session.csrf,
        ...(body ? { "content-length": String(body.length) } : {}),
        ...headers,
      },
      ...(body ? { body } : {}),
    }),
    env,
    db,
    new URL(url).pathname.slice("/manage".length),
    { now: NOW },
  );
}

const upload = (slot: string, bytes: Uint8Array, query = "") =>
  admin(
    "POST",
    `/api/products/${SLUG}/assets/${encodeURIComponent(slot)}${query}`,
    bytes,
    { "content-type": "image/png" },
  );
const release = (slot: string, query = "") =>
  admin(
    "DELETE",
    `/api/products/${SLUG}/assets/${encodeURIComponent(slot)}${query}`,
  );

async function refsOf(slot: string, locale = ""): Promise<string[]> {
  return (
    await db.all<{ storage_key: string }>(
      "SELECT storage_key FROM blob_refs WHERE product = ? AND ref_kind = ? AND ref_id = ? ORDER BY storage_key",
      SLUG,
      HOSTED_ASSET_REF,
      `${slot}@${locale}`,
    )
  ).map((r) => r.storage_key);
}

/** Sync the manifest and run every pull it queued through the real consumer step. */
async function syncAndPull(manifest: ManifestAssetSource, up: FetchImpl) {
  const before = q.sent.length;
  await syncHostedAssets(env, db, {
    product: SLUG,
    manifest,
    commit: null,
    now: NOW,
  });
  const sent = q.sent.slice(before);
  const outcomes = [];
  for (const m of sent)
    outcomes.push(await processAssetPull(ctx(up), m, noRepo));
  return { sent, outcomes };
}

// ── Acceptance ──────────────────────────────────────────────────────────────────────────────

describe("an uploaded icon survives a resync, and Revert restores the manifest's copy", () => {
  it("claims the slot, survives resyncs and a pull in flight, then reverts to the manifest", async () => {
    const up = upstream({ [URL_A]: ICON_A, [URL_B]: ICON_B });
    // The manifest's copy first.
    // `presentation.icon`, and `listing.icon`, which falls back to it.
    const first = await syncAndPull(iconManifest(URL_A), up);
    expect(first.outcomes).toEqual(["ready", "ready"]);
    expect((await getHostedAsset(db, SLUG, "presentation.icon"))?.sha256).toBe(
      sha(ICON_A),
    );

    // The operator uploads a file that is not on the web.
    const res = await upload("presentation.icon", ICON_C);
    expect(res.status, await res.clone().text()).toBe(200);
    const { asset } = (await res.json()) as Loose;
    expect(asset).toMatchObject({
      slot: "presentation.icon",
      origin: "console",
      sourceKind: "upload",
      sourceRef: null,
      status: "ready",
      sha256: sha(ICON_C),
      size: ICON_C.length,
      contentType: "image/png",
      url: `${IMG}/${SLUG}/a/${sha(ICON_C)}`,
      previewUrl: `${IMG}/${SLUG}/a/${sha(ICON_C)}`,
      uploadable: true,
      maxBytes: 10 * 1024 * 1024,
      wanted: { kind: "url", src: URL_A },
    });
    expect(await refsOf("presentation.icon")).toEqual([blobKey(sha(ICON_C))]);

    // A pull message already in flight for the manifest's ref yields.
    const stale: AssetPullMessage = {
      v: 1,
      product: SLUG,
      slot: "presentation.icon",
      locale: "",
      wanted: JSON.stringify({ kind: "url", src: URL_A }),
      reason: "recheck",
    };
    expect(await processAssetPull(ctx(up), stale, noRepo)).toBe("superseded");

    // An unchanged resync pulls nothing; a changed one records the manifest's new ref only (the
    // unclaimed `listing.icon` beside it is pulled as usual).
    const icon = (sent: AssetPullMessage[]) =>
      sent.filter((m) => m.slot === "presentation.icon");
    expect((await syncAndPull(iconManifest(URL_A), up)).sent).toEqual([]);
    expect(icon((await syncAndPull(iconManifest(URL_B), up)).sent)).toEqual([]);
    const claimed = await getHostedAsset(db, SLUG, "presentation.icon");
    expect(claimed).toMatchObject({
      origin: "console",
      sha256: sha(ICON_C),
      wanted_ref: JSON.stringify({ kind: "url", src: URL_B }),
    });

    // Revert: the console's copy goes at once, the manifest's source is pulled again.
    const rev = await release("presentation.icon");
    expect(rev.status).toBe(200);
    expect(await rev.json()).toEqual({ outcome: "reverted", pulling: true });
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "manifest",
      source_kind: "url",
      source_ref: URL_B,
      status: "pending",
      sha256: null,
    });
    expect(await refsOf("presentation.icon")).toEqual([]);
    const pull = q.sent.at(-1)!;
    expect(pull).toMatchObject({
      slot: "presentation.icon",
      wanted: JSON.stringify({ kind: "url", src: URL_B }),
      reason: "operator",
    });
    expect(await processAssetPull(ctx(up), pull, noRepo)).toBe("ready");
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "manifest",
      status: "ready",
      sha256: sha(ICON_B),
    });
    expect(await refsOf("presentation.icon")).toEqual([blobKey(sha(ICON_B))]);
    const actions = (
      await db.all<{ action: string; actor_sub: string | null }>(
        "SELECT action, actor_sub FROM audit WHERE product = ? AND action LIKE 'assets.%' ORDER BY at, rowid",
        SLUG,
      )
    ).map((a) => `${a.action}:${a.actor_sub ?? "system"}`);
    expect(actions).toContain("assets.ingest:u1");
    expect(actions).toContain("assets.revert:u1");
  });

  it("a pull whose ingest races a console upload never overwrites it (the in-batch guard)", async () => {
    await upload("presentation.icon", ICON_C);
    // Hide the claim from the pre-check only, as if the upload landed after it.
    let hidden = true;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "first")
          return async (sql: string, ...params: unknown[]) => {
            if (hidden && sql.includes("FROM hosted_assets WHERE product")) {
              hidden = false;
              return null;
            }
            return (target.first as Loose)(sql, ...params);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    const res = await ingest(
      { env, db: racing, now: NOW, fetchImpl: upstream({ [URL_A]: ICON_A }) },
      SLUG,
      "presentation.icon",
      {
        kind: "pull",
        url: URL_A,
        origin: "manifest",
        yieldsTo: ["console"],
      },
    );
    expect(res).toEqual({ ok: false, reason: "claimed" });
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "console",
      sha256: sha(ICON_C),
    });
    expect(await refsOf("presentation.icon")).toEqual([blobKey(sha(ICON_C))]);
  });
});

// ── CI ──────────────────────────────────────────────────────────────────────────────────────

/** Stage `files` under a fresh ticket of `token`, as `pkey assets push` does. */
async function stage(files: Uint8Array[], token = PUSHER): Promise<string> {
  const holder = tokens.get(token)!;
  const unique = new Map(files.map((b) => [sha(b), b]));
  const ticket = await issueUploadTicket(env, db, {
    product: SLUG,
    holder: { tokenHash: holder.tokenHash, expiresAt: holder.expiresAt },
    objects: [...unique].map(([h, b]) => ({
      sha256: h,
      size: b.length,
      gated: false,
    })),
    now: NOW,
  });
  for (const [h, b] of unique)
    await putVerified(asR2(r2), stagingKey(SLUG, ticket.ticketId, h), b, {
      sha256: h,
      size: b.length,
    });
  return ticket.ticket;
}

async function push(body: unknown, token = PUSHER): Promise<Response> {
  return dispatch(
    new Request(`${CONSOLE}/${SLUG}/assets`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    env,
    db,
  );
}

const entry = (slot: string, b: Uint8Array, locale?: string) => ({
  slot,
  ...(locale !== undefined ? { locale } : {}),
  sha256: sha(b),
  size: b.length,
});

describe("a CI push never overwrites a console claim", () => {
  it("keeps the console's upload and the manifest's slot, and hosts the free slot", async () => {
    await syncAndPull(iconManifest(URL_A), upstream({ [URL_A]: ICON_A }));
    await upload("listing.header", ICON_C);
    const header = png(9_000, 11, 1920, 1080);
    const shot = png(8_000, 13, 1280, 720, 2);
    const ticket = await stage([ICON_B, header, shot]);
    const res = await push({
      ticket,
      assets: [
        entry("presentation.icon", ICON_B),
        entry("listing.header", header),
        entry("listing.screenshot:1", shot),
      ],
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const out = (await res.json()) as Loose;
    expect(out.ok).toBe(true);
    expect(out.kept).toEqual([
      { slot: "presentation.icon", locale: "", reason: "manifest" },
      { slot: "listing.header", locale: "", reason: "console" },
    ]);
    expect(out.stored).toEqual([
      {
        slot: "listing.screenshot:1",
        locale: "",
        sha256: sha(shot),
        size: shot.length,
        contentType: "image/png",
        width: null,
        height: null,
      },
    ]);
    expect(out.refused).toEqual([]);
    expect(await getHostedAsset(db, SLUG, "listing.header")).toMatchObject({
      origin: "console",
      sha256: sha(ICON_C),
    });
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "manifest",
      sha256: sha(ICON_A),
    });
    expect(
      await getHostedAsset(db, SLUG, "listing.screenshot:1"),
    ).toMatchObject({ origin: "ci", source_kind: "ci", sha256: sha(shot) });
    const audit = await db.first<{ summary: string; actor_sub: string }>(
      "SELECT summary, actor_sub FROM audit WHERE product = ? AND action = 'assets.push'",
      SLUG,
    );
    expect(audit?.actor_sub).toBe("ci:static:tok_assets");
    expect(audit?.summary).toContain("kept 2");
  });

  it("the in-batch guard keeps a claim that lands after the pre-check", async () => {
    await upload("listing.header", ICON_C);
    let hidden = true;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "first")
          return async (sql: string, ...params: unknown[]) => {
            if (hidden && sql.includes("FROM hosted_assets WHERE product")) {
              hidden = false;
              return null;
            }
            return (target.first as Loose)(sql, ...params);
          };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    const res = await ingest(
      { env, db: racing, now: NOW },
      SLUG,
      "listing.header",
      {
        kind: "stream",
        body: new Response(ICON_B).body!,
        size: ICON_B.length,
        origin: "ci",
        sourceKind: "ci",
        expectedSha256: sha(ICON_B),
        yieldsTo: ["console", "manifest"],
        recordRefusal: false,
      },
    );
    expect(res).toEqual({ ok: false, reason: "claimed" });
    expect(await getHostedAsset(db, SLUG, "listing.header")).toMatchObject({
      origin: "console",
      sha256: sha(ICON_C),
    });
  });

  it("a manifest the product starts declaring replaces a CI copy (manifest beats CI)", async () => {
    const ticket = await stage([ICON_B]);
    await push({ ticket, assets: [entry("presentation.icon", ICON_B)] });
    expect((await getHostedAsset(db, SLUG, "presentation.icon"))?.origin).toBe(
      "ci",
    );
    const { outcomes } = await syncAndPull(
      iconManifest(URL_A),
      upstream({ [URL_A]: ICON_A }),
    );
    expect(outcomes).toEqual(["ready", "ready"]);
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "manifest",
      sha256: sha(ICON_A),
    });
  });
});

describe("POST /<p>/assets", () => {
  it("needs a pkeyci_ token with assets:write", async () => {
    const res = await push(
      { assets: [entry("presentation.icon", ICON_B)] },
      LISTER,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "missing_scope",
      scope: "assets:write",
    });
    const none = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/assets`, { method: "POST", body: "{}" }),
      env,
      db,
    );
    expect(none.status).toBe(401);
  });

  it("refuses slots CI cannot push, and bad entries, before reading anything", async () => {
    for (const slot of [
      "pack:steam",
      "youtube-url",
      "trailer-master",
      "release-file",
      `notes-image:${"a".repeat(16)}`,
      "listing.screenshot:17",
      "nonsense",
    ]) {
      const res = await push({ assets: [entry(slot, ICON_B)] });
      expect(res.status, slot).toBe(400);
      expect(((await res.json()) as Loose).reason, slot).toBe("unknown_slot");
    }
    const big = await push({
      assets: [
        { slot: "presentation.icon", sha256: sha(ICON_B), size: 11 << 20 },
      ],
    });
    expect(((await big.json()) as Loose).reason).toBe("bad_assets");
    const twice = await push({
      assets: [
        entry("listing.header", ICON_B),
        entry("listing.header", ICON_A),
      ],
    });
    expect(((await twice.json()) as Loose).reason).toBe("bad_assets");
  });

  it("needs each object in the caller's own ticket, staged with its size", async () => {
    const noTicket = await push({ assets: [entry("listing.header", ICON_B)] });
    expect(noTicket.status).toBe(403);
    expect(((await noTicket.json()) as Loose).reason).toBe("invalid_ticket");
    const ticket = await stage([ICON_A]);
    const other = await push({
      ticket,
      assets: [entry("listing.header", ICON_B)],
    });
    expect(((await other.json()) as Loose).reason).toBe("object_not_in_ticket");
    const ok = await push({
      ticket,
      assets: [entry("listing.header", ICON_A)],
    });
    expect(ok.status).toBe(200);
    const again = await push({
      ticket,
      assets: [entry("listing.header", ICON_A)],
    });
    // The product now hosts those bytes, so no ticket is needed for them.
    expect(again.status).toBe(200);
    expect(((await again.json()) as Loose).stored).toHaveLength(1);
  });

  it("answers a non-image as refused and leaves the slot as it was", async () => {
    await syncAndPull(
      {
        distribution: { listing: { header: { kind: "url", src: URL_A } } },
      } as Loose,
      upstream({ [URL_A]: ICON_A }),
    );
    const text = new TextEncoder().encode("<svg onload=alert(1)>");
    const ticket = await stage([text]);
    const res = await push({
      ticket,
      assets: [entry("listing.screenshot:2", text)],
    });
    const out = (await res.json()) as Loose;
    expect(out.ok).toBe(false);
    expect(out.refused).toEqual([
      { slot: "listing.screenshot:2", locale: "", reason: "not-an-image" },
    ]);
    expect(await getHostedAsset(db, SLUG, "listing.screenshot:2")).toBeNull();
  });

  it("mirrors a listing-model slot as an import row, and keeps an operator's", async () => {
    expect(isListingModelSlot("play:feature-graphic")).toBe(true);
    const art = png(4_000, 21, 1024, 500, 2);
    const ticket = await stage([art]);
    const res = await push({
      ticket,
      assets: [entry("play:feature-graphic", art, "fr-FR")],
    });
    expect(((await res.json()) as Loose).stored).toHaveLength(1);
    expect(
      await db.first(
        "SELECT blob, sha256, width, height, alpha, text_allowed, source, derived_from FROM dist_listing_assets WHERE product = ? AND slot = 'play:feature-graphic' AND locale = 'fr-FR'",
        SLUG,
      ),
    ).toEqual({
      blob: blobKey(sha(art)),
      sha256: sha(art),
      width: 1024,
      height: 500,
      alpha: 0,
      text_allowed: "title",
      source: "import",
      derived_from: null,
    });
    // The console's upload into the same slot is the operator's row, and CI keeps it.
    const own = png(4_100, 23, 1024, 500, 6);
    expect(
      (await upload("play:feature-graphic", own, "?locale=fr-FR")).status,
    ).toBe(200);
    const row = await db.first<{
      source: string;
      sha256: string;
      alpha: number;
    }>(
      "SELECT source, sha256, alpha FROM dist_listing_assets WHERE product = ? AND slot = 'play:feature-graphic' AND locale = 'fr-FR'",
      SLUG,
    );
    expect(row).toEqual({ source: "admin", sha256: sha(own), alpha: 1 });
    const refs = await db.all<{ storage_key: string }>(
      "SELECT storage_key FROM blob_refs WHERE product = ? AND ref_kind = 'listing-asset' AND ref_id = 'play:feature-graphic@fr-FR'",
      SLUG,
    );
    expect(refs.map((r) => r.storage_key)).toEqual([blobKey(sha(own))]);
    const t2 = await stage([art]);
    const kept = (await (
      await push({
        ticket: t2,
        assets: [entry("play:feature-graphic", art, "fr-FR")],
      })
    ).json()) as Loose;
    expect(kept.kept).toEqual([
      { slot: "play:feature-graphic", locale: "fr-FR", reason: "console" },
    ]);
    // Delete-a-copy drops the listing row holding those bytes, with its ref.
    const del = await release("play:feature-graphic", "?locale=fr-FR");
    expect(await del.json()).toEqual({ outcome: "deleted" });
    expect(
      await db.first(
        "SELECT 1 FROM dist_listing_assets WHERE product = ? AND slot = 'play:feature-graphic'",
        SLUG,
      ),
    ).toBeNull();
  });

  it("P2-02's uploads route accepts assets:write for a ticket", async () => {
    env.R2_ACCOUNT_ID = "0".repeat(32);
    env.R2_PARENT_ACCESS_KEY_ID = "AKID";
    env.R2_PARENT_SECRET_ACCESS_KEY = "secret";
    env.BLOBS_BUCKET_NAME = "pkey-blobs";
    await enableServices(db, true, SLUG);
    const res = await dispatch(
      new Request(`${CONSOLE}/${SLUG}/release/publish/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${PUSHER}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          objects: [{ sha256: sha(ICON_B), size: ICON_B.length }],
        }),
      }),
      env,
      db,
    );
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as Loose).ticket).toMatch(/^pkeyup_/);
  });
});

// ── The console routes ──────────────────────────────────────────────────────────────────────

describe("the console's upload, list and delete", () => {
  it("refuses a declared length over the cap, a missing length and a bad slot without a write", async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const over = await upload("presentation.icon", big);
    expect(over.status).toBe(413);
    expect(await over.json()).toMatchObject({
      code: "too_large",
      maxBytes: 10 * 1024 * 1024,
    });
    const bad = await upload("release-file", ICON_A);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Loose).code).toBe("bad_slot");
    const loc = await upload("listing.header", ICON_A, "?locale=not a tag");
    expect(((await loc.json()) as Loose).code).toBe("bad_locale");
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toBeNull();
  });

  it("a refused upload leaves the slot's copy serving and unmarked", async () => {
    await syncAndPull(iconManifest(URL_A), upstream({ [URL_A]: ICON_A }));
    const res = await upload(
      "presentation.icon",
      new TextEncoder().encode("GIF? no, plain text"),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: "asset_refused",
      reason: "not-an-image",
    });
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toMatchObject({
      origin: "manifest",
      status: "ready",
      error: null,
      sha256: sha(ICON_A),
    });
  });

  it("delete-a-copy drops an unclaimed copy at once; the next resync pulls it again", async () => {
    const up = upstream({ [URL_A]: ICON_A });
    await syncAndPull(iconManifest(URL_A), up);
    const res = await release("presentation.icon");
    expect(await res.json()).toEqual({ outcome: "deleted" });
    expect(await getHostedAsset(db, SLUG, "presentation.icon")).toBeNull();
    expect(await refsOf("presentation.icon")).toEqual([]);
    expect((await release("presentation.icon")).status).toBe(404);
    const again = await syncAndPull(iconManifest(URL_A), up);
    expect(again.sent.map((m) => m.slot)).toEqual(["presentation.icon"]);
    expect(again.outcomes).toEqual(["ready"]);
  });

  it("a claim with no manifest source is deleted, not reverted", async () => {
    await upload("listing.header", ICON_C);
    expect(await (await release("listing.header")).json()).toEqual({
      outcome: "deleted",
    });
    expect(await getHostedAsset(db, SLUG, "listing.header")).toBeNull();
  });

  it("lists sizesPending only while the Images binding is bound, with the ladder and preview", async () => {
    await upload("listing.header", ICON_C);
    const list = async () =>
      (
        (await (
          await admin("GET", `/api/products/${SLUG}/assets`)
        ).json()) as Loose
      ).assets as Loose[];
    expect((await list())[0]).toMatchObject({
      slot: "listing.header",
      sizesPending: false,
      widths: [],
      uploadable: true,
      maxBytes: 20 * 1024 * 1024,
    });
    env.IMAGES = {} as ImagesBinding;
    expect((await list())[0].sizesPending).toBe(true);
    await db.run(
      "UPDATE hosted_assets SET variants_json = ?, width = 1920 WHERE product = ? AND slot = 'listing.header'",
      JSON.stringify(
        [1280, 640, 1920].map((w) => ({
          w,
          format: "image/webp",
          sha256: sha(new Uint8Array([w & 0xff])),
          size: 5,
        })),
      ),
      SLUG,
    );
    const row = (await list())[0];
    expect(row.sizesPending).toBe(false);
    expect(row.widths).toEqual([640, 1280, 1920]);
    expect(row.previewUrl).toBe(`${IMG}/${SLUG}/a/${sha(ICON_C)}/640.webp`);
  });

  it("plans no pull for a claimed slot (the planner reads the claim)", async () => {
    await upload("presentation.icon", ICON_C);
    const plan = await planHostedAssetPulls(db, {
      product: SLUG,
      manifest: iconManifest(URL_B),
      commit: null,
      now: NOW,
    });
    expect(plan.messages.map((m) => m.slot)).toEqual(["listing.icon"]);
  });
});

// ── Slots and headers ───────────────────────────────────────────────────────────────────────

describe("upload slots", () => {
  it("are the image slots but notes images", () => {
    for (const s of [
      "presentation.icon",
      "listing.icon",
      "listing.header",
      "listing.screenshot:16",
      "icon-master",
      "play:icon",
      "steam:library-hero",
      "app-store:screenshot:tablet:3",
    ])
      expect(isUploadSlot(s), s).toBe(true);
    for (const s of [
      "listing.screenshot:0",
      "pack:play",
      "youtube-url",
      "trailer-master",
      "release-file:abc",
      `notes-image:${"b".repeat(32)}`,
      "__proto__",
    ])
      expect(isUploadSlot(s), s).toBe(false);
    expect(uploadSlotMaxBytes("play:icon")).toBe(10 * 1024 * 1024);
    expect(uploadSlotMaxBytes("key-art")).toBe(20 * 1024 * 1024);
    expect(uploadSlotMaxBytes("release-file")).toBeNull();
  });
});

describe("imageHeaderInfo", () => {
  it("reads PNG dimensions and alpha (colour type, tRNS)", () => {
    expect(imageHeaderInfo(png(100, 1, 640, 480, 6), "image/png")).toEqual({
      width: 640,
      height: 480,
      alpha: true,
    });
    expect(imageHeaderInfo(png(100, 1, 64, 32, 2), "image/png")).toEqual({
      width: 64,
      height: 32,
      alpha: false,
    });
    const palette = png(100, 1, 16, 16, 3);
    palette.set([0, 0, 0, 3, 0x74, 0x52, 0x4e, 0x53], 33); // tRNS
    expect(imageHeaderInfo(palette, "image/png").alpha).toBe(true);
  });

  it("reads GIF, WebP and JPEG headers", () => {
    const gif = new Uint8Array(40);
    gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0], 0);
    gif.set([0x21, 0xf9, 0x04, 0x01], 20);
    expect(imageHeaderInfo(gif, "image/gif")).toEqual({
      width: 10,
      height: 20,
      alpha: true,
    });
    const webp = (chunk: string) => {
      const b = new Uint8Array(40);
      b.set(new TextEncoder().encode("RIFF"), 0);
      b.set(new TextEncoder().encode("WEBP"), 8);
      b.set(new TextEncoder().encode(chunk), 12);
      return b;
    };
    const vp8x = webp("VP8X");
    vp8x[20] = 0x10;
    vp8x.set([99, 0, 0, 49, 0, 0], 24);
    expect(imageHeaderInfo(vp8x, "image/webp")).toEqual({
      width: 100,
      height: 50,
      alpha: true,
    });
    const vp8l = webp("VP8L");
    vp8l[20] = 0x2f;
    const bits = (299 | (199 << 14) | (1 << 28)) >>> 0;
    vp8l.set(
      [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, bits >>> 24],
      21,
    );
    expect(imageHeaderInfo(vp8l, "image/webp")).toEqual({
      width: 300,
      height: 200,
      alpha: true,
    });
    const vp8 = webp("VP8 ");
    vp8.set([0x80, 0x02, 0xe0, 0x01], 26);
    expect(imageHeaderInfo(vp8, "image/webp")).toEqual({
      width: 640,
      height: 480,
      alpha: false,
    });
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11,
      0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0, 0, 0, 0,
    ]);
    expect(imageHeaderInfo(jpeg, "image/jpeg")).toEqual({
      width: 640,
      height: 480,
      alpha: false,
    });
    expect(imageHeaderInfo(new Uint8Array(4), "image/avif")).toEqual({
      width: null,
      height: null,
      alpha: false,
    });
  });
});
