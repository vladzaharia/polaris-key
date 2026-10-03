/// <reference types="@cloudflare/workers-types" />
// ── Pack ingest on workerd (P4-02, plans/P4-01.md decision 36) ────────────────────────────
//
// The Node lane proves the checks. This proves the parts whose behaviour depends on the runtime
// that ships: `@polaris-key/zstd-wasm`'s workerd entry (a `WebAssembly.Module` import,
// instantiated per decode, since workerd compiles no WASM bytes at request time), one files
// index of exactly `MAX_PUBLISHED_INDEX_BYTES` read from miniflare's R2 and parsed inside the
// isolate, the bound refused before any read one byte over it, and the batched `json_each`
// possession check with a 20,000-pair bound value on D1. P4-22 adds the chunk index: the
// largest valid one under the bound parsed in the isolate, one of exactly the bound read and
// parsed, one a byte over refused before any read, a missing bundle, and a bundle that only
// another pack holds a ref to.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAX_PUBLISHED_INDEX_BYTES,
  parseManifestPackDeliverable,
} from "@polaris-key/manifest";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import { decode } from "@polaris-key/zstd-wasm";
import { D1Db } from "../src/db/d1.js";
import {
  checkPackAgainstDeclaration,
  checkPackStore,
  firstMissingObject,
  packReleaseId,
  packReleaseStatements,
} from "../src/services/release/packs/ingest.js";
import { NOW, seedProduct } from "./seed.js";

const LANE = { timeout: 60_000 };

/** Storage is isolated per test FILE (vitest-pool-workers 0.13+), not per test, so a product
 *  several tests here share is seeded once and reused. Each test's packs use their own seeds,
 *  so no two tests write the same bytes, rows or release ids. */
const seeded = new Map<string, Promise<void>>();
function seedOnce(db: D1Db, slug: string): Promise<void> {
  let done = seeded.get(slug);
  if (!done) {
    done = seedProduct(env, db, slug, { schemaVersion: 1, entries: [] });
    seeded.set(slug, done);
  }
  return done;
}
const PACK = "djdl.core3d";

async function hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fill(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
}

/** One zstd frame of raw blocks (RFC 8878 §3.1.1.2), single-segment, 4-byte content size. */
function rawZstdFrame(content: Uint8Array): Uint8Array {
  const parts: number[] = [0x28, 0xb5, 0x2f, 0xfd, 0xa0];
  const n = content.length;
  parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const chunks: number[][] = [parts];
  const blocks: Uint8Array[] = [];
  let pos = 0;
  do {
    const size = Math.min(128 * 1024, n - pos);
    const h = (size << 3) | (pos + size >= n ? 1 : 0);
    chunks.push([h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff]);
    blocks.push(content.subarray(pos, pos + size));
    pos += size;
  } while (pos < n);
  const total =
    chunks.reduce((a, c) => a + c.length, 0) +
    blocks.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  out.set(chunks[0]!, at);
  at += chunks[0]!.length;
  for (let i = 0; i < blocks.length; i++) {
    out.set(chunks[i + 1]!, at);
    at += 3;
    out.set(blocks[i]!, at);
    at += blocks[i]!.length;
  }
  return out;
}

interface Stored {
  bytes: Uint8Array;
  sha256: string;
}

/**
 * A one-variant container pack: a 4-byte gap then a 60-byte file. The index is padded with an
 * unknown member (ignored by `pkey-files/1`) to exactly `indexBytes` decoded bytes, and stored
 * raw (`none`) or as a raw-block zstd frame.
 */
async function pack(
  indexBytes: number | null,
  codec: "none" | "zstd",
  seed: number,
): Promise<{ record: PackRecordDoc; objects: Stored[] }> {
  const gap = fill(4, seed);
  const file = fill(60, seed + 1);
  const payload = new Uint8Array([...gap, ...file]);
  const payloadSha = await hex(payload);
  const fileSha = await hex(file);
  const base = {
    format: "pkey-files/1",
    layout: "container",
    payload: { size: payload.length, sha256: payloadSha },
    files: [
      {
        path: "assets/core/a.bin",
        offset: 4,
        size: file.length,
        sha256: fileSha,
        blob: { sha256: fileSha, bytes: file.length, codec: "none" },
      },
    ],
  };
  let text = JSON.stringify({ ...base, pad: "" });
  if (indexBytes !== null)
    text = JSON.stringify({
      ...base,
      pad: "x".repeat(indexBytes - text.length),
    });
  const index = new TextEncoder().encode(text);
  if (indexBytes !== null) expect(index.length).toBe(indexBytes);
  const stored = codec === "zstd" ? rawZstdFrame(index) : index;
  const indexObj = { bytes: stored, sha256: await hex(stored) };
  const record: PackRecordDoc = {
    schemaVersion: 1,
    aud: "packs-w",
    deliverable: PACK,
    kind: "pack",
    version: `1.0.${seed}`,
    seq: seed,
    issuedAt: NOW,
    type: "godot.pck",
    formatVersion: 4,
    variants: [
      {
        variant: {},
        payload: { size: payload.length, sha256: payloadSha },
        full: {
          sha256: payloadSha,
          bytes: payload.length,
          size: payload.length,
          codec: "none",
        },
        files: {
          format: "pkey-files/1",
          layout: "container",
          sha256: indexObj.sha256,
          bytes: stored.length,
          size: index.length,
          codec,
          gaps: {
            sha256: await hex(gap),
            bytes: gap.length,
            size: gap.length,
            codec: "none",
          },
        },
      },
    ],
  };
  return {
    record,
    objects: [
      { bytes: payload, sha256: payloadSha },
      indexObj,
      { bytes: gap, sha256: await hex(gap) },
      { bytes: file, sha256: fileSha },
    ],
  };
}

const DECLARATION = parseManifestPackDeliverable(
  JSON.stringify({
    kind: "pack",
    id: PACK,
    type: "godot.pck",
    handler: { prefixes: ["res://assets/core/"] },
    requires: { engine: "godot-4.7" },
  }),
)!;

/** Store each object in R2 and record it with a ref of `product` (a promoted upload by
 *  `holder`, the pack by default). */
async function store(
  db: D1Db,
  product: string,
  objects: Stored[],
  holder = PACK,
) {
  for (const o of objects) {
    const key = `blobs/sha256/${o.sha256}`;
    await env.BLOBS!.put(key, o.bytes);
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, ?, 'blob', 0, ?, ?) ON CONFLICT DO NOTHING`,
      key,
      o.sha256,
      o.bytes.length,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES (?, ?, 'pack-upload', ?, ?) ON CONFLICT DO NOTHING`,
      product,
      key,
      holder,
      NOW,
    );
  }
}

/**
 * A pack whose one variant carries a raw `pkey-chunks/1` index of `records` one-byte chunks over
 * a `records`-byte payload, all in one bundle of `records` bytes. `indexBytes` pads the index
 * past its records (a structurally wrong length, for the exact-bound case).
 */
async function chunkedPack(
  records: number,
  seed: number,
  indexBytes?: number,
): Promise<{
  record: PackRecordDoc;
  objects: Stored[];
  index: Stored;
  bundle: Stored;
}> {
  const p = await pack(null, "none", seed);
  // Re-shape the payload to `records` bytes: a 4-byte gap, then one file.
  const gap = fill(4, seed);
  const file = fill(records - 4, seed + 1);
  const payload = new Uint8Array([...gap, ...file]);
  const payloadSha = await hex(payload);
  const fileSha = await hex(file);
  const indexDoc = new TextEncoder().encode(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "container",
      payload: { size: payload.length, sha256: payloadSha },
      files: [
        {
          path: "assets/core/a.bin",
          offset: 4,
          size: file.length,
          sha256: fileSha,
          blob: { sha256: fileSha, bytes: file.length, codec: "none" },
        },
      ],
    }),
  );
  const bundleBytes = fill(records, seed + 7).reverse();
  const bundle = { bytes: bundleBytes, sha256: await hex(bundleBytes) };
  const n = records;
  const chunk = new Uint8Array(indexBytes ?? 64 + 48 * (n + 1));
  const dv = new DataView(chunk.buffer);
  chunk.set(new TextEncoder().encode("PKEYCHNK"), 0);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 48, true);
  dv.setUint32(12, 1, true);
  dv.setUint32(16, n, true);
  dv.setUint32(20, 1, true);
  dv.setUint32(24, payload.length, true);
  for (let i = 0; i < 32; i++)
    chunk[32 + i] = parseInt(payloadSha.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < n; i++) {
    const o = 64 + 48 * i;
    dv.setUint32(o + 32, 1, true);
    dv.setUint32(o + 36, 1, true);
    dv.setUint32(o + 40, 0, true);
    dv.setUint32(o + 44, i, true);
  }
  const b = 64 + 48 * n;
  for (let i = 0; i < 32; i++)
    chunk[b + i] = parseInt(bundle.sha256.slice(i * 2, i * 2 + 2), 16);
  dv.setUint32(b + 32, records, true);
  const index = { bytes: chunk, sha256: await hex(chunk) };
  const record = structuredClone(p.record);
  const v = record.variants[0]!;
  v.payload = { size: payload.length, sha256: payloadSha };
  v.full = {
    sha256: payloadSha,
    bytes: payload.length,
    size: payload.length,
    codec: "none",
  };
  const filesIndex = { bytes: indexDoc, sha256: await hex(indexDoc) };
  v.files = {
    format: "pkey-files/1",
    layout: "container",
    sha256: filesIndex.sha256,
    bytes: indexDoc.length,
    size: indexDoc.length,
    codec: "none",
    gaps: {
      sha256: await hex(gap),
      bytes: gap.length,
      size: gap.length,
      codec: "none",
    },
  };
  v.chunks = {
    format: "pkey-chunks/1",
    sha256: index.sha256,
    bytes: chunk.length,
    size: chunk.length,
    codec: "none",
  };
  return {
    record,
    objects: [
      { bytes: payload, sha256: payloadSha },
      filesIndex,
      { bytes: gap, sha256: await hex(gap) },
      { bytes: file, sha256: fileSha },
    ],
    index,
    bundle,
  };
}

describe("@polaris-key/zstd-wasm in the Worker's module graph", LANE, () => {
  it("decodes through the workerd entry", () => {
    const text = new TextEncoder().encode("pkey-files/1 ".repeat(50));
    expect(
      new TextDecoder().decode(decode(rawZstdFrame(text), text.length)),
    ).toBe("pkey-files/1 ".repeat(50));
  });

  it("ingests a pack whose index is a zstd frame (decoded by the WASM decoder at ingest)", async () => {
    const db = new D1Db(env.DB);
    await seedOnce(db, "packs-w");
    const p = await pack(null, "zstd", 1);
    await store(db, "packs-w", p.objects);
    expect(checkPackAgainstDeclaration(p.record, DECLARATION, null)).toBeNull();
    const res = await checkPackStore(db, env.BLOBS!, "packs-w", p.record);
    expect(res).toEqual({
      ok: true,
      files: 1,
      unreadIndexes: [],
      bundles: 0,
      unverifiedChunks: [],
    });
  });
});

describe("the index bound (MAX_PUBLISHED_INDEX_BYTES)", LANE, () => {
  it("ingests a record whose index is exactly the bound, and writes its rows", async () => {
    const db = new D1Db(env.DB);
    await seedOnce(db, "packs-w");
    const p = await pack(MAX_PUBLISHED_INDEX_BYTES, "none", 2);
    expect(p.record.variants[0]!.files.size).toBe(MAX_PUBLISHED_INDEX_BYTES);
    await store(db, "packs-w", p.objects);
    expect(checkPackAgainstDeclaration(p.record, DECLARATION, null)).toBeNull();
    expect(await checkPackStore(db, env.BLOBS!, "packs-w", p.record)).toEqual({
      ok: true,
      files: 1,
      unreadIndexes: [],
      bundles: 0,
      unverifiedChunks: [],
    });
    await db.batch(
      packReleaseStatements({
        product: "packs-w",
        record: p.record,
        recordSha256: "a".repeat(64),
        kid: "k",
        jws: "x.y.z",
        metadataAccess: "public",
        artifactsAccess: "public",
        now: NOW,
      }),
    );
    expect(
      await db.first(
        "SELECT deliverable_id, seq FROM release_metadata WHERE product = ? AND release_id = ?",
        "packs-w",
        packReleaseId(p.record),
      ),
    ).toEqual({ deliverable_id: PACK, seq: 2 });
  });

  it("refuses a record that declares one byte more, before anything is read", async () => {
    const p = await pack(null, "none", 3);
    const over = structuredClone(p.record);
    over.variants[0]!.files.size = MAX_PUBLISHED_INDEX_BYTES + 1;
    // Nothing is stored: the refusal comes from the declared size alone.
    expect(checkPackAgainstDeclaration(over, DECLARATION, null)).toMatchObject({
      ok: false,
      reason: "pack-index",
    });
  });
});

describe(
  "the chunk index at ingest (P4-22, plans/P4-10.md section 6)",
  LANE,
  () => {
    /** The most records an index under MAX_PUBLISHED_INDEX_BYTES holds with one bundle. */
    const MAX_RECORDS = Math.floor((MAX_PUBLISHED_INDEX_BYTES - 64) / 48) - 1;

    it("parses the largest index under the bound inside the isolate and checks its bundle", async () => {
      const db = new D1Db(env.DB);
      await seedOnce(db, "packs-c");
      const p = await chunkedPack(MAX_RECORDS, 11);
      expect(p.index.bytes.length).toBe(MAX_PUBLISHED_INDEX_BYTES - 16);
      await store(db, "packs-c", [...p.objects, p.index, p.bundle]);
      expect(
        checkPackAgainstDeclaration(p.record, DECLARATION, null),
      ).toBeNull();
      expect(await checkPackStore(db, env.BLOBS!, "packs-c", p.record)).toEqual(
        {
          ok: true,
          files: 1,
          unreadIndexes: [],
          bundles: 1,
          unverifiedChunks: [],
        },
      );
    });

    it("reads and parses an index of exactly the bound (no index of 48-byte records is that long, so it fails its length), and refuses one a byte over before any read", async () => {
      const db = new D1Db(env.DB);
      await seedOnce(db, "packs-c");
      const p = await chunkedPack(1000, 12, MAX_PUBLISHED_INDEX_BYTES);
      expect(p.record.variants[0]!.chunks!.size).toBe(
        MAX_PUBLISHED_INDEX_BYTES,
      );
      await store(db, "packs-c", [...p.objects, p.index, p.bundle]);
      expect(
        checkPackAgainstDeclaration(p.record, DECLARATION, null),
      ).toBeNull();
      expect(
        await checkPackStore(db, env.BLOBS!, "packs-c", p.record),
      ).toMatchObject({
        ok: false,
        reason: "pack-index",
        message: "variants[0]'s chunk index fails chunks-bad-length.",
      });
      const over = structuredClone(p.record);
      over.variants[0]!.chunks!.size = MAX_PUBLISHED_INDEX_BYTES + 1;
      over.variants[0]!.chunks!.codec = "zstd";
      expect(
        checkPackAgainstDeclaration(over, DECLARATION, null),
      ).toMatchObject({
        ok: false,
        reason: "pack-index",
      });
    });

    it("refuses a missing bundle, and a bundle only another pack holds a ref to (pack-object)", async () => {
      const db = new D1Db(env.DB);
      await seedOnce(db, "packs-c");
      const p = await chunkedPack(64, 13);
      await store(db, "packs-c", [...p.objects, p.index]);
      const missing = await checkPackStore(db, env.BLOBS!, "packs-c", p.record);
      expect(missing).toMatchObject({ ok: false, reason: "pack-object" });
      expect((missing as { message: string }).message).toContain(
        `blobs/sha256/${p.bundle.sha256}`,
      );
      // Stored, and referenced by the product — but through another pack's upload.
      await store(db, "packs-c", [p.bundle], "djdl.other");
      expect(
        await checkPackStore(db, env.BLOBS!, "packs-c", p.record),
      ).toMatchObject({ ok: false, reason: "pack-object" });
      // This pack's own upload earns it.
      await store(db, "packs-c", [p.bundle]);
      expect(
        await checkPackStore(db, env.BLOBS!, "packs-c", p.record),
      ).toMatchObject({ ok: true, bundles: 1 });
    });
  },
);

describe("the json_each possession check on D1", LANE, () => {
  it("checks 20,000 [key, bytes] pairs in two bound values", async () => {
    const db = new D1Db(env.DB);
    await seedOnce(db, "packs-j");
    const blob = fill(10, 9);
    const sha = await hex(blob);
    const key = `blobs/sha256/${sha}`;
    await db.run(
      `INSERT INTO blob_objects (storage_key, sha256, size, kind, gated, verified_at, created_at)
       VALUES (?, ?, 10, 'blob', 0, ?, ?)`,
      key,
      sha,
      NOW,
      NOW,
    );
    await db.run(
      `INSERT INTO blob_refs (product, storage_key, ref_kind, ref_id, created_at)
       VALUES ('packs-j', ?, 'pack-upload', ?, ?)`,
      key,
      PACK,
      NOW,
    );
    const pairs = Array.from({ length: 20000 }, () => [key, 10] as const);
    expect(await firstMissingObject(db, "packs-j", pairs)).toBeNull();
    const missing = `blobs/sha256/${"f".repeat(64)}`;
    const withMissing = [...pairs.slice(0, 19999), [missing, 1] as const];
    expect(await firstMissingObject(db, "packs-j", withMissing)).toBe(missing);
  });
});
