/// <reference types="@cloudflare/workers-types" />
// ── Hosted-asset ingest on miniflare's R2 and D1 (HA-01) ─────────────────────────────────
//
// The Node lane (`test/hostedAssets.test.ts`) covers the rules against `test/r2Mock.ts`. This
// file runs the ingest against the real bindings, which is what proves the parts the fake could
// get wrong: that R2 stores and returns `httpMetadata.contentType`, that a peeked stream piped
// through workerd's `FixedLengthStream` still lands byte for byte, that R2 itself refuses a
// streamed release file whose bytes miss the expected hash, and that the row, the ref and the
// audit row commit as one real D1 batch.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { blobKey, putVerified } from "../src/core/assets/blobs.js";
import {
  HOSTED_ASSET_REF,
  getHostedAsset,
  ingest,
  parseVariants,
  rebuildLadder,
  type IngestContext,
} from "../src/core/assets/hostedAssets.js";
import type { FetchImpl } from "../src/core/safeFetch.js";
import { D1Db } from "../src/db/d1.js";
import { NOW, seedProduct } from "./seed.js";

const LANE = { timeout: 60_000 };

function bucket(): R2Bucket {
  if (!env.BLOBS) throw new Error("BLOBS is not bound in the workerd lane");
  return env.BLOBS;
}

function bytesWith(sig: number[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65_536)
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65_536, n)));
  out.set(sig, 0);
  return out;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function streamOf(bytes: Uint8Array, chunk = 4093): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (pos >= bytes.length) return c.close();
      c.enqueue(bytes.slice(pos, pos + chunk));
      pos += chunk;
    },
  });
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function context(slug: string): Promise<IngestContext> {
  const db = new D1Db(env.DB);
  await seedProduct(env, db, slug, { schemaVersion: 1, entries: [] });
  return { env: { BLOBS: bucket() }, db, now: NOW };
}

describe("hosted-asset ingest on R2 and D1", LANE, () => {
  it("hosts a PNG: object with image/png, row, ref and audit in one batch", async () => {
    const ctx = await context("ha-png");
    const png = bytesWith(PNG_SIG, 300_000);
    const h = await hex(png);
    ctx.fetchImpl = (async () =>
      new Response(streamOf(png), {
        headers: { "content-length": String(png.length), etag: '"w1"' },
      })) as FetchImpl;
    const res = await ingest(ctx, "ha-png", "presentation.icon", {
      kind: "pull",
      url: "https://cdn.example.com/icon.png",
      origin: "manifest",
    });
    expect(res).toMatchObject({
      ok: true,
      sha256: h,
      contentType: "image/png",
    });
    const head = await bucket().head(blobKey(h));
    expect(head?.httpMetadata?.contentType).toBe("image/png");
    expect(head?.size).toBe(png.length);
    expect(
      await getHostedAsset(ctx.db, "ha-png", "presentation.icon"),
    ).toMatchObject({
      status: "ready",
      sha256: h,
      source_etag: '"w1"',
    });
    const refs = await ctx.db.all<{ ref_kind: string; ref_id: string }>(
      "SELECT ref_kind, ref_id FROM blob_refs WHERE product = 'ha-png'",
    );
    expect(refs).toEqual([
      { ref_kind: HOSTED_ASSET_REF, ref_id: "presentation.icon@" },
    ]);
    const audit = await ctx.db.all<{ action: string }>(
      "SELECT action FROM audit WHERE product = 'ha-png' AND action = 'assets.ingest'",
    );
    expect(audit).toHaveLength(1);
  });

  it("refuses an SVG and a redirect to our own zone", async () => {
    const ctx = await context("ha-refuse");
    const svg = new TextEncoder().encode(
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
    );
    const refusedSvg = await ingest(ctx, "ha-refuse", "listing.header", {
      kind: "stream",
      body: streamOf(svg),
      size: svg.length,
      sourceKind: "upload",
      origin: "console",
    });
    expect(refusedSvg).toEqual({ ok: false, reason: "not-an-image" });

    const dialled: string[] = [];
    ctx.fetchImpl = (async (input: Request | string) => {
      dialled.push(typeof input === "string" ? input : input.url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://key.plrs.im/admin" },
      });
    }) as FetchImpl;
    const refusedHop = await ingest(ctx, "ha-refuse", "presentation.icon", {
      kind: "pull",
      url: "https://cdn.example.com/icon.png",
      origin: "manifest",
    });
    expect(refusedHop).toEqual({ ok: false, reason: "guard:denied-host" });
    expect(dialled).toEqual(["https://cdn.example.com/icon.png"]);
  });

  it("streams a release file through FixedLengthStream, and R2 refuses a wrong hash", async () => {
    const ctx = await context("ha-release");
    const file = bytesWith([0x50, 0x4b, 3, 4], 3 * 1024 * 1024 + 17);
    const h = await hex(file);
    const wrong = await ingest(ctx, "ha-release", "release-file:a1", {
      kind: "stream",
      body: streamOf(file, 65_536),
      size: file.length,
      sourceKind: "github-asset",
      origin: "release-mirror",
      expectedSha256: "0".repeat(64),
    });
    expect(wrong).toEqual({ ok: false, reason: "sha256-mismatch" });
    const ok = await ingest(ctx, "ha-release", "release-file:a1", {
      kind: "stream",
      body: streamOf(file, 65_536),
      size: file.length,
      sourceKind: "github-asset",
      origin: "release-mirror",
      expectedSha256: h,
    });
    expect(ok).toMatchObject({ ok: true, sha256: h });
    const obj = await bucket().get(blobKey(h));
    expect(obj?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(await hex(new Uint8Array(await obj!.arrayBuffer()))).toBe(h);
  });

  it("putVerified stores the sniffed type from a peeked stream", async () => {
    const png = bytesWith(PNG_SIG, 70_000);
    const h = await hex(png);
    const res = await putVerified(bucket(), blobKey(h), streamOf(png, 5), {
      sha256: h,
      size: png.length,
    });
    expect(res.ok).toBe(true);
    const obj = await bucket().get(blobKey(h));
    expect(obj?.httpMetadata?.contentType).toBe("image/png");
    expect(await hex(new Uint8Array(await obj!.arrayBuffer()))).toBe(h);
  });

  it("stores the variant ladder (HA-03) as WebP objects, held with the original in one batch", async () => {
    const ctx = await context("ha-ladder");
    const png = bytesWith(PNG_SIG, 50_000);
    const h = await hex(png);
    const webpSig = [...new TextEncoder().encode("RIFF"), 1, 2, 3, 4];
    const webp = (w: number) =>
      bytesWith([...webpSig, ...new TextEncoder().encode("WEBPVP8 ")], 500 + w);
    const made = new Map<number, Uint8Array>();
    // A stub binding: miniflare's local Images is not what this lane proves; R2 and D1 are.
    ctx.env = {
      BLOBS: bucket(),
      IMAGES: {
        info: async () => ({
          format: "image/png",
          fileSize: png.length,
          width: 200,
          height: 200,
        }),
        input: () => {
          let w = 0;
          const t = {
            transform: (tr: { width: number }) => ((w = tr.width), t),
            output: async () => {
              const b = webp(w);
              made.set(w, b);
              return {
                image: () => streamOf(b),
                contentType: () => "image/webp",
              };
            },
          };
          return t;
        },
      } as unknown as ImagesBinding,
    };
    const res = await ingest(ctx, "ha-ladder", "presentation.icon", {
      kind: "stream",
      body: streamOf(png),
      size: png.length,
      sourceKind: "upload",
      origin: "console",
    });
    expect(res).toMatchObject({ ok: true, sha256: h, width: 200 });
    const row = await getHostedAsset(ctx.db, "ha-ladder", "presentation.icon");
    const variants = parseVariants(row?.variants_json ?? null);
    expect(variants.map((v) => v.w)).toEqual([64, 128]);
    for (const v of variants) {
      expect(v.sha256).toBe(await hex(made.get(v.w)!));
      const obj = await bucket().get(blobKey(v.sha256));
      expect(obj?.httpMetadata?.contentType).toBe("image/webp");
      expect(await hex(new Uint8Array(await obj!.arrayBuffer()))).toBe(
        v.sha256,
      );
    }
    const refs = await ctx.db.all<{ storage_key: string; ref_id: string }>(
      "SELECT storage_key, ref_id FROM blob_refs WHERE product = 'ha-ladder' ORDER BY storage_key",
    );
    expect(refs.map((r) => r.storage_key)).toEqual(
      [h, ...variants.map((v) => v.sha256)].map((x) => blobKey(x)).sort(),
    );
    expect(refs.every((r) => r.ref_id === "presentation.icon@")).toBe(true);
  });
  it("rebuilds an owed ladder from the stored original, and a second slot of the family reuses it", async () => {
    const ctx = await context("ha-rebuild");
    const png = bytesWith(PNG_SIG, 40_000);
    const h = await hex(png);
    const webpSig = [...new TextEncoder().encode("RIFF"), 1, 2, 3, 4];
    const webp = (w: number) =>
      bytesWith([...webpSig, ...new TextEncoder().encode("WEBPVP8 ")], 400 + w);
    let quota = true;
    const made: number[] = [];
    const images = {
      info: async () => ({
        format: "image/png",
        fileSize: png.length,
        width: 130,
        height: 130,
      }),
      input: (s: ReadableStream<Uint8Array>) => {
        let w = 0;
        const t = {
          transform: (tr: { width: number }) => ((w = tr.width), t),
          output: async () => {
            // The original reached the binding byte for byte, read back from R2.
            expect(
              await hex(new Uint8Array(await new Response(s).arrayBuffer())),
            ).toBe(h);
            if (quota)
              throw Object.assign(new Error("ERROR 9422"), { code: 9422 });
            made.push(w);
            const b = webp(w);
            return {
              image: () => streamOf(b),
              contentType: () => "image/webp",
            };
          },
        };
        return t;
      },
    } as unknown as ImagesBinding;
    ctx.env = { BLOBS: bucket(), IMAGES: images };
    const upload = (slot: string) =>
      ingest(ctx, "ha-rebuild", slot, {
        kind: "stream",
        body: streamOf(png),
        size: png.length,
        sourceKind: "upload",
        origin: "console",
      });
    expect(await upload("presentation.icon")).toMatchObject({
      ok: true,
      width: 130,
    });
    expect(
      (await getHostedAsset(ctx.db, "ha-rebuild", "presentation.icon"))
        ?.variants_json,
    ).toBe("[]");

    quota = false;
    expect(
      await rebuildLadder(ctx, "ha-rebuild", "presentation.icon", "", h),
    ).toBe("built");
    expect(made).toEqual([64, 128]);
    const variants = parseVariants(
      (await getHostedAsset(ctx.db, "ha-rebuild", "presentation.icon"))
        ?.variants_json ?? null,
    );
    expect(variants.map((v) => v.w)).toEqual([64, 128]);
    // A second rebuild finds nothing owed: the guarded batch applies once.
    expect(
      await rebuildLadder(ctx, "ha-rebuild", "presentation.icon", "", h),
    ).toBe("superseded");

    // The same bytes in listing.icon: no transformation, its own refs to the same variants.
    expect(await upload("listing.icon")).toMatchObject({
      ok: true,
      width: 130,
    });
    expect(made).toEqual([64, 128]);
    const refs = await ctx.db.all<{ storage_key: string; ref_id: string }>(
      "SELECT storage_key, ref_id FROM blob_refs WHERE product = 'ha-rebuild' ORDER BY ref_id, storage_key",
    );
    const keys = [h, ...variants.map((v) => v.sha256)]
      .map((x) => blobKey(x))
      .sort();
    expect(refs).toEqual(
      ["listing.icon@", "presentation.icon@"].flatMap((ref_id) =>
        keys.map((storage_key) => ({ storage_key, ref_id })),
      ),
    );
    const audit = await ctx.db.all<{ summary: string }>(
      "SELECT summary FROM audit WHERE product = 'ha-rebuild' AND action = 'assets.variants'",
    );
    expect(audit).toEqual([
      { summary: "presentation.icon: sizes 64, 128 from the stored copy" },
    ]);
  });
});
