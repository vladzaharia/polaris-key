/**
 * HA-01 — the hosted-asset ingest (`core/hostedAssets.ts`; notes/S-20 §6.2, §6.3), the content
 * sniff (`core/sniff.ts`), and the Content-Type every R2 put now stores (S-20 §4.6 #1), down to the
 * Play listing-image read that depended on it.
 */
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HOSTED_ASSET_REF,
  HostedAssetError,
  IMAGES_QUOTA_ERROR,
  SLOT_CLASSES,
  VARIANT_LADDERS,
  getHostedAsset,
  ingest,
  ladderWidths,
  parseVariants,
  slotClass,
  variantFamily,
  type IngestContext,
} from "../src/core/hostedAssets.js";
import { peekStream, sniffContentType } from "../src/core/sniff.js";
import {
  blobKey,
  promote,
  putVerified,
  stagingKey,
} from "../src/core/blobs.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import { playImageFromListingAsset } from "../src/services/distribution/connectors/play/storefront.js";
import type { Env } from "../src/env.js";
import type { SqliteDb } from "../src/db/sqlite.js";
import { makeTestDb } from "./helpers.js";
import { R2Mock, asR2, installDigestStream } from "./r2Mock.js";
import { NOW, seedProduct } from "./seed.js";

beforeAll(() => installDigestStream());

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function filled(sig: number[], n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  out.set(sig, 0);
  return out;
}
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG = filled(PNG_SIG, 20_000);
const PNG2 = filled(PNG_SIG, 30_000, 9);
const enc = (s: string) => new TextEncoder().encode(s);
const SVG = enc(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const HTML = enc("<!doctype html><html><body>hi</body></html>");
const MP4 = filled([0, 0, 0, 0x20, ...enc("ftypisom")], 4096);

function stream(bytes: Uint8Array, chunk = 997): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= bytes.length) return c.close();
      c.enqueue(bytes.slice(pos, pos + chunk));
      pos += chunk;
    },
  });
}

/** An upstream serving fixed bodies, by URL. */
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

const serve =
  (bytes: Uint8Array, headers: Record<string, string> = {}) =>
  () =>
    new Response(stream(bytes), {
      headers: { "content-length": String(bytes.length), ...headers },
    });

let db: SqliteDb;
let r2: R2Mock;
let ctx: IngestContext;

beforeEach(async () => {
  db = makeTestDb();
  r2 = new R2Mock();
  await seedProduct(db, "djdl");
  await seedProduct(db, "other");
  ctx = { env: { BLOBS: asR2(r2) }, db, now: NOW };
});

async function refs(product = "djdl") {
  return db.all<{ storage_key: string; ref_kind: string; ref_id: string }>(
    "SELECT storage_key, ref_kind, ref_id FROM blob_refs WHERE product = ? ORDER BY storage_key",
    product,
  );
}

async function audits(product = "djdl") {
  return db.all<{ action: string; target_id: string; summary: string }>(
    "SELECT action, target_id, summary FROM audit WHERE product = ? AND action = 'assets.ingest' ORDER BY rowid",
    product,
  );
}

// ── The sniff ────────────────────────────────────────────────────────────────────────────────

describe("sniffContentType", () => {
  it("reads the raster types and MP4 from their magic numbers", () => {
    expect(sniffContentType(PNG)).toBe("image/png");
    expect(sniffContentType(filled([0xff, 0xd8, 0xff], 64))).toBe("image/jpeg");
    expect(
      sniffContentType(
        filled([...enc("RIFF"), 1, 2, 3, 4, ...enc("WEBPVP8 ")], 64),
      ),
    ).toBe("image/webp");
    expect(sniffContentType(filled([...enc("GIF89a")], 64))).toBe("image/gif");
    expect(
      sniffContentType(filled([0, 0, 0, 0x1c, ...enc("ftypavif")], 64)),
    ).toBe("image/avif");
    expect(sniffContentType(MP4)).toBe("video/mp4");
  });

  it("never answers SVG or HTML, whatever the bytes", () => {
    for (const doc of [
      SVG,
      HTML,
      enc('<?xml version="1.0"?><svg/>'),
      enc("<script>x</script>"),
      filled([0, 0, 0, 0x18, ...enc("ftypheic")], 64),
      new Uint8Array(0),
    ])
      expect(sniffContentType(doc)).toBe("application/octet-stream");
  });

  it("peeks without losing a byte", async () => {
    const { head, stream: again } = await peekStream(stream(PNG, 5), 32);
    expect([...head]).toEqual([...PNG.subarray(0, 32)]);
    const back = new Uint8Array(await new Response(again).arrayBuffer());
    expect(sha(back)).toBe(sha(PNG));
  });
});

// ── Slots ────────────────────────────────────────────────────────────────────────────────────

describe("slotClass", () => {
  it("knows every S-20 §6.1 slot, with its cap", () => {
    expect(slotClass("presentation.icon")).toBe(SLOT_CLASSES.icon);
    expect(slotClass("listing.header")).toBe(SLOT_CLASSES.art);
    expect(slotClass("listing.screenshot:3")).toBe(SLOT_CLASSES.art);
    expect(slotClass("play:feature-graphic")).toBe(SLOT_CLASSES.art);
    expect(slotClass("play:icon")).toBe(SLOT_CLASSES.icon);
    expect(slotClass("notes-image:0123456789abcdef")).toBe(
      SLOT_CLASSES["notes-image"],
    );
    expect(slotClass("trailer-master")).toBe(SLOT_CLASSES.video);
    expect(slotClass("release-file")).toBe(SLOT_CLASSES["release-file"]);
    expect(SLOT_CLASSES.icon.maxBytes).toBe(10 * 1024 * 1024);
    expect(SLOT_CLASSES.art.maxBytes).toBe(20 * 1024 * 1024);
    expect(SLOT_CLASSES["notes-image"].maxBytes).toBe(5 * 1024 * 1024);
    expect(SLOT_CLASSES.video.maxBytes).toBe(512 * 1024 * 1024);
  });

  it("refuses everything else", () => {
    for (const s of [
      "",
      "listing.screenshot:17",
      "listing.screenshot:0",
      "pack:play",
      "youtube-url",
      "../etc",
      "presentation.accent",
    ])
      expect(slotClass(s)).toBeNull();
  });

  it("throws, writing nothing, for a slot, product or locale no caller should pass", async () => {
    const input = {
      kind: "pull",
      url: "https://cdn.example.com/a.png",
      origin: "manifest",
    } as const;
    await expect(ingest(ctx, "djdl", "pack:play", input)).rejects.toThrow(
      HostedAssetError,
    );
    await expect(
      ingest(ctx, "DJDL", "presentation.icon", input),
    ).rejects.toThrow(HostedAssetError);
    await expect(
      ingest(ctx, "djdl", "presentation.icon", { ...input, locale: "../x" }),
    ).rejects.toThrow(HostedAssetError);
    expect(await db.all("SELECT * FROM hosted_assets")).toEqual([]);
  });
});

// ── Ingest ───────────────────────────────────────────────────────────────────────────────────

describe("ingest", () => {
  const URL_ = "https://cdn.example.com/art/icon.png";

  it("hosts a pulled PNG: the object (image/png), the row, the ref and the audit", async () => {
    ctx.fetchImpl = upstream({ [URL_]: serve(PNG, { etag: '"e1"' }) });
    const res = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    expect(res).toEqual({
      ok: true,
      status: "ready",
      sha256: sha(PNG),
      size: PNG.length,
      contentType: "image/png",
      width: null,
      height: null,
    });
    const head = await asR2(r2).head(blobKey(sha(PNG)));
    expect(head?.httpMetadata?.contentType).toBe("image/png");
    const row = await getHostedAsset(db, "djdl", "presentation.icon");
    expect(row).toMatchObject({
      origin: "manifest",
      source_kind: "url",
      source_ref: URL_,
      source_etag: '"e1"',
      sha256: sha(PNG),
      size: PNG.length,
      content_type: "image/png",
      variants_json: "[]",
      status: "ready",
      error: null,
      checked_at: NOW,
    });
    expect(await refs()).toEqual([
      {
        storage_key: blobKey(sha(PNG)),
        ref_kind: HOSTED_ASSET_REF,
        ref_id: "presentation.icon@",
      },
    ]);
    expect(await audits()).toEqual([
      {
        action: "assets.ingest",
        target_id: "presentation.icon@",
        summary: `presentation.icon: hosted from url (image/png, ${PNG.length} bytes)`,
      },
    ]);
  });

  it("records the dimensions when the Images binding is bound", async () => {
    ctx.env = {
      BLOBS: asR2(r2),
      IMAGES: {
        info: async () => ({
          format: "image/png",
          fileSize: PNG.length,
          width: 512,
          height: 256,
        }),
      } as unknown as ImagesBinding,
    };
    const res = await ingest(ctx, "djdl", "listing.header", {
      kind: "stream",
      body: stream(PNG),
      size: PNG.length,
      sourceKind: "upload",
      origin: "console",
    });
    expect(res).toMatchObject({ ok: true, width: 512, height: 256 });
    expect(await getHostedAsset(db, "djdl", "listing.header")).toMatchObject({
      width: 512,
      height: 256,
    });
  });

  for (const [what, bytes] of [
    ["an SVG", SVG],
    ["an HTML file", HTML],
  ] as const) {
    it(`refuses ${what} as not-an-image, served as image/svg+xml or not`, async () => {
      ctx.fetchImpl = upstream({
        [URL_]: serve(bytes, { "content-type": "image/png" }),
      });
      const res = await ingest(ctx, "djdl", "presentation.icon", {
        kind: "pull",
        url: URL_,
        origin: "manifest",
      });
      expect(res).toEqual({ ok: false, reason: "not-an-image" });
      expect(r2.keys()).toEqual([]);
      expect(
        await getHostedAsset(db, "djdl", "presentation.icon"),
      ).toMatchObject({
        status: "failed",
        error: "not-an-image",
        sha256: null,
        source_ref: URL_,
      });
      expect(await refs()).toEqual([]);
      expect((await audits()).at(-1)?.summary).toBe(
        "presentation.icon: refused (not-an-image)",
      );
    });
  }

  it("refuses an over-cap stream: declared, and while streaming", async () => {
    const cap = SLOT_CLASSES["notes-image"].maxBytes;
    const declared = await ingest(ctx, "djdl", "notes-image:0123456789abcdef", {
      kind: "stream",
      body: stream(PNG),
      size: cap + 1,
      sourceKind: "ci",
      origin: "ci",
    });
    expect(declared).toEqual({ ok: false, reason: "too-large" });

    // A pull whose Content-Length lies: the counter, not the header, decides.
    const big = filled(PNG_SIG, cap + 10);
    ctx.fetchImpl = upstream({
      [URL_]: () =>
        new Response(stream(big, 65_536), {
          headers: { "content-length": "100" },
        }),
    });
    const streamed = await ingest(ctx, "djdl", "notes-image:0123456789abcdef", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    expect(streamed).toEqual({ ok: false, reason: "too-large" });
    expect(r2.keys()).toEqual([]);
  });

  it("refuses a stream shorter or longer than it declared", async () => {
    const res = await ingest(ctx, "djdl", "listing.header", {
      kind: "stream",
      body: stream(PNG),
      size: PNG.length + 1,
      sourceKind: "upload",
      origin: "console",
    });
    expect(res).toEqual({ ok: false, reason: "size-mismatch" });
  });

  it("refuses bytes that miss the expected hash", async () => {
    ctx.fetchImpl = upstream({ [URL_]: serve(PNG) });
    const res = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
      expectedSha256: sha(PNG2),
    });
    expect(res).toEqual({ ok: false, reason: "sha256-mismatch" });
    expect(r2.keys()).toEqual([]);
  });

  it("refuses a redirect to a denied host at the hop", async () => {
    ctx.fetchImpl = upstream({
      [URL_]: () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://key.plrs.im/admin/api/products" },
        }),
    });
    const res = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    expect(res).toEqual({ ok: false, reason: "guard:denied-host" });
    expect(ctx.fetchImpl).toBeDefined();
    expect((ctx.fetchImpl as FetchImpl & { calls: string[] }).calls).toEqual([
      URL_,
    ]);
  });

  it("is idempotent: re-ingesting the same bytes adds nothing", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await ingest(ctx, "djdl", "presentation.icon", {
        kind: "stream",
        body: stream(PNG),
        size: PNG.length,
        sourceKind: "upload",
        origin: "console",
      });
      expect(res).toMatchObject({ ok: true, sha256: sha(PNG) });
    }
    expect(r2.keys()).toEqual([blobKey(sha(PNG))]);
    expect(await refs()).toHaveLength(1);
  });

  it("earns a ref to bytes another product stored only by delivering every byte", async () => {
    await ingest(ctx, "other", "presentation.icon", {
      kind: "stream",
      body: stream(PNG),
      size: PNG.length,
      sourceKind: "upload",
      origin: "console",
    });
    // Naming the hash is no proof: bytes that are not those bytes are refused.
    const liar = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "stream",
      body: stream(PNG2),
      size: PNG2.length,
      sourceKind: "upload",
      origin: "console",
      expectedSha256: sha(PNG),
    });
    expect(liar).toEqual({ ok: false, reason: "sha256-mismatch" });
    expect(await refs()).toEqual([]);
    const real = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "stream",
      body: stream(PNG),
      size: PNG.length,
      sourceKind: "upload",
      origin: "console",
    });
    expect(real).toMatchObject({ ok: true, sha256: sha(PNG) });
    expect(await refs()).toHaveLength(1);
  });

  it("swaps a replaced copy's refs in the same batch", async () => {
    for (const bytes of [PNG, PNG2]) {
      await ingest(ctx, "djdl", "listing.screenshot:1", {
        kind: "stream",
        body: stream(bytes),
        size: bytes.length,
        sourceKind: "upload",
        origin: "console",
      });
    }
    expect(await refs()).toEqual([
      {
        storage_key: blobKey(sha(PNG2)),
        ref_kind: HOSTED_ASSET_REF,
        ref_id: "listing.screenshot:1@",
      },
    ]);
    expect(
      await getHostedAsset(db, "djdl", "listing.screenshot:1"),
    ).toMatchObject({ sha256: sha(PNG2) });
  });

  it("keeps the last good copy when a later pull fails, and marks a gone source stale", async () => {
    ctx.fetchImpl = upstream({ [URL_]: serve(PNG) });
    await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    ctx.fetchImpl = upstream({
      [URL_]: () => new Response("boom", { status: 503 }),
    });
    expect(
      await ingest(ctx, "djdl", "presentation.icon", {
        kind: "pull",
        url: URL_,
        origin: "manifest",
      }),
    ).toEqual({ ok: false, reason: "status:503" });
    expect(await getHostedAsset(db, "djdl", "presentation.icon")).toMatchObject(
      {
        status: "failed",
        error: "status:503",
        sha256: sha(PNG),
      },
    );
    ctx.fetchImpl = upstream({});
    await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    expect(await getHostedAsset(db, "djdl", "presentation.icon")).toMatchObject(
      {
        status: "stale",
        error: "status:404",
        sha256: sha(PNG),
      },
    );
    expect(await refs()).toHaveLength(1);
  });

  it("sends the stored validator on a re-pull and treats a 304 as no work", async () => {
    ctx.fetchImpl = upstream({ [URL_]: serve(PNG, { etag: '"e1"' }) });
    await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    let sent: string | null = null;
    ctx.fetchImpl = async (_input, init) => {
      sent = new Headers(init?.headers).get("if-none-match");
      return new Response(null, { status: 304 });
    };
    const res = await ingest(ctx, "djdl", "presentation.icon", {
      kind: "pull",
      url: URL_,
      origin: "manifest",
    });
    expect(sent).toBe('"e1"');
    expect(res).toEqual({ ok: true, status: "unchanged", sha256: sha(PNG) });
  });

  it("streams a release file only against an expected hash and a known length", async () => {
    const file = filled([0x50, 0x4b, 3, 4], 50_000);
    ctx.fetchImpl = upstream({
      "https://objects.githubusercontent.com/f": serve(file),
    });
    const wrong = await ingest(ctx, "djdl", "release-file:a1", {
      kind: "pull",
      url: "https://objects.githubusercontent.com/f",
      origin: "release-mirror",
      sourceKind: "github-asset",
      expectedSha256: sha(PNG),
    });
    expect(wrong).toEqual({ ok: false, reason: "sha256-mismatch" });
    expect(r2.has(blobKey(sha(PNG)))).toBe(false);

    const none = await ingest(ctx, "djdl", "release-file:a1", {
      kind: "pull",
      url: "https://objects.githubusercontent.com/f",
      origin: "release-mirror",
      sourceKind: "github-asset",
    });
    expect(none).toEqual({ ok: false, reason: "unverifiable" });

    const good = await ingest(ctx, "djdl", "release-file:a1", {
      kind: "pull",
      url: "https://objects.githubusercontent.com/f",
      origin: "release-mirror",
      sourceKind: "github-asset",
      expectedSha256: sha(file),
    });
    expect(good).toMatchObject({
      ok: true,
      sha256: sha(file),
      contentType: "application/octet-stream",
    });
    expect(
      (await asR2(r2).head(blobKey(sha(file))))?.httpMetadata?.contentType,
    ).toBe("application/octet-stream");

    // Already stored: the bytes are still read and checked before the ref is kept.
    const again = await ingest(ctx, "djdl", "release-file:a1", {
      kind: "pull",
      url: "https://objects.githubusercontent.com/f",
      origin: "release-mirror",
      sourceKind: "github-asset",
      expectedSha256: sha(file),
      force: true,
    });
    expect(again).toMatchObject({ ok: true, sha256: sha(file) });
  });

  it("takes only MP4 into a video slot", async () => {
    const ok = await ingest(ctx, "djdl", "trailer-master", {
      kind: "stream",
      body: stream(MP4),
      size: MP4.length,
      sourceKind: "upload",
      origin: "console",
      expectedSha256: sha(MP4),
    });
    expect(ok).toMatchObject({ ok: true, contentType: "video/mp4" });
    const png = await ingest(ctx, "djdl", "trailer-master", {
      kind: "stream",
      body: stream(PNG),
      size: PNG.length,
      sourceKind: "upload",
      origin: "console",
      expectedSha256: sha(PNG),
    });
    expect(png).toEqual({ ok: false, reason: "not-a-video" });
  });

  it("does nothing without a blob store", async () => {
    ctx.env = {};
    expect(
      await ingest(ctx, "djdl", "presentation.icon", {
        kind: "pull",
        url: URL_,
        origin: "manifest",
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
    expect(await db.all("SELECT * FROM hosted_assets")).toEqual([]);
  });
});

// ── The variant ladder (HA-03; S-20 §6.6) ────────────────────────────────────────────────────

/** A fake WebP whose bytes depend on the source and the width, so each variant is distinct. */
function fakeWebp(width: number, source: number): Uint8Array {
  return filled(
    [...enc("RIFF"), 1, 2, 3, 4, ...enc("WEBPVP8 ")],
    200 + width,
    width * 31 + source,
  );
}

interface StubOptions {
  width: number | null;
  /** Throw this ImagesError code from `output()` at the nth transformation (0-based). */
  failAt?: { n: number; code: number };
  /** Answer bytes that are not WebP. */
  notWebp?: boolean;
}

/** A stub Images binding: `.info()` answers `width`, and each transform answers a fake WebP. */
function stubImages(opts: StubOptions): ImagesBinding & { widths: number[] } {
  const widths: number[] = [];
  const binding = {
    widths,
    info: async (s: ReadableStream<Uint8Array>) => {
      const bytes = new Uint8Array(await new Response(s).arrayBuffer());
      if (opts.width === null)
        throw Object.assign(new Error("not an image"), { code: 9412 });
      return {
        format: "image/png",
        fileSize: bytes.length,
        width: opts.width,
        height: opts.width,
      };
    },
    input: (s: ReadableStream<Uint8Array>) => {
      let w = 0;
      const t = {
        transform(tr: { width?: number; fit?: string }) {
          expect(tr.fit).toBe("scale-down");
          w = tr.width ?? 0;
          return t;
        },
        async output(o: { format: string }) {
          expect(o.format).toBe("image/webp");
          const src = new Uint8Array(await new Response(s).arrayBuffer());
          if (opts.failAt && widths.length === opts.failAt.n)
            throw Object.assign(new Error(`ERROR ${opts.failAt.code}`), {
              code: opts.failAt.code,
            });
          widths.push(w);
          const bytes = opts.notWebp
            ? PNG.slice(0, 300)
            : fakeWebp(w, src.length);
          return {
            image: () => stream(bytes),
            contentType: () => "image/webp",
            response: () => new Response(bytes),
          };
        },
      };
      return t;
    },
  };
  return binding as unknown as ImagesBinding & { widths: number[] };
}

async function variantsOf(slot: string) {
  return parseVariants(
    (await getHostedAsset(db, "djdl", slot))?.variants_json ?? null,
  );
}

function upload(bytes: Uint8Array) {
  return {
    kind: "stream" as const,
    body: stream(bytes),
    size: bytes.length,
    sourceKind: "upload" as const,
    origin: "console" as const,
  };
}

describe("variant ladder", () => {
  it("has the S-20 §6.6 ladders per slot family, and only for those slots", () => {
    expect(VARIANT_LADDERS).toEqual({
      icon: [64, 128, 256, 512, 1024],
      header: [640, 1280, 1920],
      screenshots: [480, 960, 1920],
    });
    expect(variantFamily("presentation.icon")).toBe("icon");
    expect(variantFamily("listing.icon")).toBe("icon");
    expect(variantFamily("listing.header")).toBe("header");
    expect(variantFamily("listing.screenshot:16")).toBe("screenshots");
    expect(variantFamily("listing.screenshot:17")).toBeNull();
    // Store-exact art (A-18d), notes images, video and release files get no ladder.
    for (const slot of [
      "play:icon",
      "play:feature-graphic",
      "notes-image:0123456789abcdef",
      "trailer-master",
      "release-file",
    ])
      expect(variantFamily(slot)).toBeNull();
  });

  it("never upscales", () => {
    expect(ladderWidths("presentation.icon", 512)).toEqual([64, 128, 256, 512]);
    expect(ladderWidths("presentation.icon", 63)).toEqual([]);
    expect(ladderWidths("listing.header", 1919)).toEqual([640, 1280]);
    expect(ladderWidths("listing.screenshot:1", 4000)).toEqual([
      480, 960, 1920,
    ]);
    expect(ladderWidths("listing.header", null)).toEqual([]);
  });

  it("a 512 px icon yields the 64, 128, 256 and 512 variants, and no 1024", async () => {
    const images = stubImages({ width: 512 });
    ctx.env = { BLOBS: asR2(r2), IMAGES: images };
    const res = await ingest(ctx, "djdl", "presentation.icon", upload(PNG));
    expect(res).toMatchObject({ ok: true, width: 512 });
    expect(images.widths).toEqual([64, 128, 256, 512]);
    const variants = await variantsOf("presentation.icon");
    expect(variants.map((v) => v.w)).toEqual([64, 128, 256, 512]);
    for (const v of variants) {
      const bytes = fakeWebp(v.w, PNG.length);
      expect(v).toEqual({
        w: v.w,
        format: "image/webp",
        sha256: sha(bytes),
        size: bytes.length,
      });
      const head = await asR2(r2).head(blobKey(v.sha256));
      expect(head?.httpMetadata?.contentType).toBe("image/webp");
      expect(head?.size).toBe(bytes.length);
    }
    // Each variant is held by the slot's ref, beside the original.
    expect((await refs()).map((r) => r.storage_key).sort()).toEqual(
      [sha(PNG), ...variants.map((v) => v.sha256)]
        .map((h) => blobKey(h))
        .sort(),
    );
    expect((await refs()).every((r) => r.ref_id === "presentation.icon@")).toBe(
      true,
    );
    expect((await audits()).at(-1)?.summary).toBe(
      `presentation.icon: hosted from upload (image/png, ${PNG.length} bytes; sizes 64, 128, 256, 512)`,
    );
  });

  it("without the binding, variants_json is [] and the ingest succeeds", async () => {
    ctx.env = { BLOBS: asR2(r2) };
    const res = await ingest(ctx, "djdl", "presentation.icon", upload(PNG));
    expect(res).toMatchObject({ ok: true, status: "ready", sha256: sha(PNG) });
    expect(
      (await getHostedAsset(db, "djdl", "presentation.icon"))?.variants_json,
    ).toBe("[]");
    expect(r2.keys()).toEqual([blobKey(sha(PNG))]);
    expect(await refs()).toHaveLength(1);
  });

  it(`on error ${IMAGES_QUOTA_ERROR} (quota), variants_json is [] and the ingest succeeds`, async () => {
    const images = stubImages({
      width: 1920,
      failAt: { n: 1, code: IMAGES_QUOTA_ERROR },
    });
    ctx.env = { BLOBS: asR2(r2), IMAGES: images };
    const res = await ingest(ctx, "djdl", "listing.header", upload(PNG));
    expect(res).toMatchObject({ ok: true, status: "ready" });
    const row = await getHostedAsset(db, "djdl", "listing.header");
    expect(row).toMatchObject({
      status: "ready",
      variants_json: "[]",
      error: null,
    });
    // All or nothing: the one variant made before the failure is not held by any ref.
    expect(await refs()).toEqual([
      {
        storage_key: blobKey(sha(PNG)),
        ref_kind: HOSTED_ASSET_REF,
        ref_id: "listing.header@",
      },
    ]);
  });

  it("makes no variants when the width is unknown or the output is not WebP", async () => {
    ctx.env = { BLOBS: asR2(r2), IMAGES: stubImages({ width: null }) };
    expect(
      await ingest(ctx, "djdl", "presentation.icon", upload(PNG)),
    ).toMatchObject({
      ok: true,
      width: null,
    });
    expect(await variantsOf("presentation.icon")).toEqual([]);
    ctx.env = {
      BLOBS: asR2(r2),
      IMAGES: stubImages({ width: 960, notWebp: true }),
    };
    expect(
      await ingest(ctx, "djdl", "listing.screenshot:2", upload(PNG)),
    ).toMatchObject({
      ok: true,
    });
    expect(await variantsOf("listing.screenshot:2")).toEqual([]);
  });

  it("makes no variants for a slot without a ladder", async () => {
    const images = stubImages({ width: 4096 });
    ctx.env = { BLOBS: asR2(r2), IMAGES: images };
    await ingest(ctx, "djdl", "notes-image:0123456789abcdef", upload(PNG));
    expect(images.widths).toEqual([]);
    expect(await variantsOf("notes-image:0123456789abcdef")).toEqual([]);
  });

  it("reuses the variants of unchanged bytes, and drops a replaced copy's with it", async () => {
    const images = stubImages({ width: 1000 });
    ctx.env = { BLOBS: asR2(r2), IMAGES: images };
    await ingest(ctx, "djdl", "listing.screenshot:1", upload(PNG));
    const first = await variantsOf("listing.screenshot:1");
    expect(first.map((v) => v.w)).toEqual([480, 960]);
    // The same bytes again: no new transformations, the same variants and refs.
    await ingest(ctx, "djdl", "listing.screenshot:1", upload(PNG));
    expect(images.widths).toEqual([480, 960]);
    expect(await variantsOf("listing.screenshot:1")).toEqual(first);
    expect(await refs()).toHaveLength(3);
    // New bytes: the old original and its variants lose their refs in the same batch.
    await ingest(ctx, "djdl", "listing.screenshot:1", upload(PNG2));
    const second = await variantsOf("listing.screenshot:1");
    expect(second.map((v) => v.w)).toEqual([480, 960]);
    expect((await refs()).map((r) => r.storage_key).sort()).toEqual(
      [sha(PNG2), ...second.map((v) => v.sha256)].map((h) => blobKey(h)).sort(),
    );
  });

  it("builds the ladder on a re-ingest of bytes that had none (the binding came back)", async () => {
    ctx.env = { BLOBS: asR2(r2) };
    await ingest(ctx, "djdl", "presentation.icon", upload(PNG));
    expect(await variantsOf("presentation.icon")).toEqual([]);
    ctx.env = { BLOBS: asR2(r2), IMAGES: stubImages({ width: 128 }) };
    await ingest(ctx, "djdl", "presentation.icon", upload(PNG));
    expect((await variantsOf("presentation.icon")).map((v) => v.w)).toEqual([
      64, 128,
    ]);
    expect(await refs()).toHaveLength(3);
  });

  it("keeps the variants with the last good copy when a later ingest fails", async () => {
    ctx.env = { BLOBS: asR2(r2), IMAGES: stubImages({ width: 256 }) };
    await ingest(ctx, "djdl", "presentation.icon", upload(PNG));
    const refused = await ingest(ctx, "djdl", "presentation.icon", upload(SVG));
    expect(refused).toEqual({ ok: false, reason: "not-an-image" });
    expect((await variantsOf("presentation.icon")).map((v) => v.w)).toEqual([
      64, 128, 256,
    ]);
    expect(await refs()).toHaveLength(4);
  });

  it("reads a malformed variants_json as no variants", () => {
    expect(parseVariants(null)).toEqual([]);
    expect(parseVariants("not json")).toEqual([]);
    expect(parseVariants('{"w":64}')).toEqual([]);
    expect(
      parseVariants('[{"w":64,"format":"image/png","sha256":"x","size":1}]'),
    ).toEqual([]);
  });
});

// ── Content-Type on every put (S-20 §4.6 #1) ─────────────────────────────────────────────────

describe("Content-Type on R2 puts", () => {
  it("putVerified stores the sniffed type for a buffer and a stream", async () => {
    const b = await putVerified(asR2(r2), blobKey(sha(PNG)), PNG, {
      sha256: sha(PNG),
      size: PNG.length,
    });
    expect(b.ok).toBe(true);
    expect(
      (await asR2(r2).head(blobKey(sha(PNG))))?.httpMetadata?.contentType,
    ).toBe("image/png");
    const s = await putVerified(asR2(r2), blobKey(sha(HTML)), stream(HTML, 3), {
      sha256: sha(HTML),
      size: HTML.length,
    });
    expect(s.ok).toBe(true);
    expect(
      (await asR2(r2).head(blobKey(sha(HTML))))?.httpMetadata?.contentType,
    ).toBe("application/octet-stream");
  });

  it("a PNG promoted from CI staging reaches Play as image/png", async () => {
    // As the CLI's S3 PUT stores it: no Content-Type at all.
    const staged = stagingKey("djdl", "tkt_png", sha(PNG));
    r2.seed(staged, PNG, { withSha256: true });
    const res = await promote(
      asR2(r2),
      staged,
      blobKey(sha(PNG)),
      { sha256: sha(PNG), size: PNG.length },
      { db, now: NOW, product: "djdl" },
    );
    expect(res.ok).toBe(true);
    await insertListingAsset(sha(PNG));
    const img = await playImageFromListingAsset(
      { BLOBS: asR2(r2) } as Env,
      db,
      "djdl",
      "play:icon",
      "",
    );
    expect(img?.contentType).toBe("image/png");
    expect(img?.size).toBe(PNG.length);
  });

  it("Play sniffs an object stored before the fix, which has no Content-Type", async () => {
    r2.seed(blobKey(sha(PNG)), PNG, { withSha256: true });
    expect(
      (await asR2(r2).head(blobKey(sha(PNG))))?.httpMetadata?.contentType,
    ).toBeUndefined();
    await insertListingAsset(sha(PNG));
    const img = await playImageFromListingAsset(
      { BLOBS: asR2(r2) } as Env,
      db,
      "djdl",
      "play:icon",
      "",
    );
    expect(img?.contentType).toBe("image/png");
  });
});

async function insertListingAsset(hex: string): Promise<void> {
  await db.run(
    `INSERT INTO dist_listing_assets (product, slot, locale, blob, sha256, width, height, alpha,
       derived_from, text_allowed, source, modified_at, modified_by)
     VALUES ('djdl', 'play:icon', '', ?, ?, 512, 512, 1, NULL, 'free', 'import', ?, 'ci')`,
    blobKey(hex),
    hex,
    NOW,
  );
}
