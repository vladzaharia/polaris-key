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
import { blobKey, putVerified } from "../src/core/blobs.js";
import {
  HOSTED_ASSET_REF,
  getHostedAsset,
  ingest,
  type IngestContext,
} from "../src/core/hostedAssets.js";
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
});
