// Unit proofs for P4-10's `pkey-chunks/1` parser and `planTarget`'s chunk rule (plans/P4-10.md
// §2.3, §2.5), on top of the corpus (`content/cases.json#chunkIndexCases`, `plan-matrix.json
// #targetCases`, which every SDK replays). These pin what no corpus vector carries: reads at an
// unaligned byte offset, the u64 rule's saturation on both u64 fields, the `maxBytes` option, a
// missing decoder, and the claims at `chunks` (checks 81–83, the two integer paths).
//
// @pkey-feature packs.index.chunks

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CHUNKS_FORMAT,
  MAX_CHUNK_BYTES,
  MAX_CHUNK_INDEX_BYTES,
} from "@polaris-key/protocol/core";
import type { PackVariant } from "@polaris-key/protocol/packs";
import { releaseRecordClaims } from "../src/index.js";
import {
  parseChunkIndex,
  parseChunkIndexBytes,
  planTarget,
  readU64,
} from "../src/packs/index.js";

const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const hexBytes = (h: string): Uint8Array =>
  Uint8Array.from(Buffer.from(h, "hex"));

/** A two-chunk payload in one raw bundle, and its index. */
function fixture(): {
  payload: Uint8Array;
  index: Uint8Array;
  ids: string[];
  bundle: string;
} {
  const a = new Uint8Array(100).fill(0x61);
  const b = new Uint8Array(50).fill(0x62);
  const payload = new Uint8Array([...a, ...b]);
  const bundleBytes = payload;
  const ids = [sha(a), sha(b)];
  const out = new Uint8Array(64 + 48 * 3);
  const dv = new DataView(out.buffer);
  out.set([0x50, 0x4b, 0x45, 0x59, 0x43, 0x48, 0x4e, 0x4b], 0);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 48, true);
  dv.setUint32(12, 1, true);
  dv.setUint32(16, 2, true);
  dv.setUint32(20, 1, true);
  dv.setUint32(24, 150, true);
  out.set(hexBytes(sha(payload)), 32);
  const rec = (i: number, id: string, len: number, off: number): void => {
    const o = 64 + 48 * i;
    out.set(hexBytes(id), o);
    dv.setUint32(o + 32, len, true);
    dv.setUint32(o + 36, len, true);
    dv.setUint32(o + 40, 0, true);
    dv.setUint32(o + 44, off, true);
  };
  rec(0, ids[0]!, 100, 0);
  rec(1, ids[1]!, 50, 100);
  out.set(hexBytes(sha(bundleBytes)), 64 + 96);
  dv.setUint32(64 + 96 + 32, 150, true);
  return { payload, index: out, ids, bundle: sha(bundleBytes) };
}

const rawRef = (b: Uint8Array) => ({
  sha256: sha(b),
  bytes: b.byteLength,
  size: b.byteLength,
  codec: "none",
});

describe("parseChunkIndex (plans/P4-10.md §2.3)", () => {
  it("parses a raw index bound to its payload", async () => {
    const f = fixture();
    const r = await parseChunkIndex(f.index, rawRef(f.index), {
      size: 150,
      sha256: sha(f.payload),
    });
    expect(r).toEqual({
      ok: true,
      index: {
        fileAware: true,
        payloadSize: 150,
        payloadSha256: sha(f.payload),
        records: [
          [f.ids[0], 100, 100, 0, 0],
          [f.ids[1], 50, 50, 0, 100],
        ],
        bundles: [[f.bundle, 150]],
      },
    });
  });

  it("reads through a DataView at an unaligned byte offset", () => {
    const f = fixture();
    const host = new Uint8Array(f.index.byteLength + 3);
    host.set(f.index, 3);
    const view = host.subarray(3);
    expect(view.byteOffset % 4).not.toBe(0);
    const r = parseChunkIndexBytes(view, null);
    expect(r.ok).toBe(true);
  });

  it("the u64 rule: two u32 words, low first, saturated at 2^53", () => {
    const b = new Uint8Array(8);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 7, true);
    dv.setUint32(4, 1, true);
    expect(readU64(dv, 0)).toBe(4294967296 + 7);
    dv.setUint32(4, 0x00200000, true);
    expect(readU64(dv, 0)).toBe(2 ** 53);
    dv.setUint32(4, 0xffffffff, true);
    expect(readU64(dv, 0)).toBe(2 ** 53);
  });

  it("a saturated payloadSize never equals a sum of lengths", () => {
    const f = fixture();
    new DataView(f.index.buffer).setUint32(28, 0x00200000, true);
    expect(parseChunkIndexBytes(f.index, null)).toEqual({
      ok: false,
      error: "chunks-size-mismatch",
    });
  });

  it("`maxBytes` bounds `ref.size` before the stored bytes are read", async () => {
    const f = fixture();
    expect(
      await parseChunkIndex(f.index, rawRef(f.index), null, {
        maxBytes: f.index.byteLength - 1,
      }),
    ).toEqual({ ok: false, error: "chunks-ref-mismatch" });
    expect(
      await parseChunkIndex(
        new Uint8Array(),
        {
          ...rawRef(f.index),
          size: MAX_CHUNK_INDEX_BYTES + 1,
        },
        null,
      ),
    ).toEqual({ ok: false, error: "chunks-ref-mismatch" });
  });

  it("a zstd ref without a decoder, or an unknown codec, is chunks-ref-mismatch", async () => {
    const f = fixture();
    for (const codec of ["zstd", "lz4"])
      expect(
        await parseChunkIndex(f.index, { ...rawRef(f.index), codec }, null),
      ).toEqual({ ok: false, error: "chunks-ref-mismatch" });
  });

  it("a throwing decoder is chunks-ref-mismatch, never an exception", async () => {
    const f = fixture();
    const r = await parseChunkIndex(
      f.index,
      { ...rawRef(f.index), codec: "zstd", size: 9999 },
      null,
      {
        decode: () => {
          throw new Error("boom");
        },
      },
    );
    expect(r).toEqual({ ok: false, error: "chunks-ref-mismatch" });
  });
});

describe("planTarget's chunk rule (plans/P4-10.md §2.5)", () => {
  const f = fixture();
  const payload = { size: 150, sha256: sha(f.payload) };
  const variant = (over: Record<string, unknown> = {}): PackVariant =>
    ({
      variant: {},
      payload,
      full: { sha256: "b".repeat(64), bytes: 10, size: 150, codec: "zstd" },
      files: {
        format: "pkey-files/1",
        layout: "container",
        sha256: "c".repeat(64),
        bytes: 10,
        size: 20,
        codec: "zstd",
        gaps: { sha256: "d".repeat(64), bytes: 0, size: 0, codec: "none" },
      },
      chunks: { format: CHUNKS_FORMAT, ...rawRef(f.index) },
      ...over,
    }) as PackVariant;
  const parsed = parseChunkIndexBytes(f.index, payload);
  if (!parsed.ok) throw new Error("fixture");
  const idx = parsed.index;

  it("maps a usable index to its bytes and inline records", () => {
    expect(planTarget(variant(), "7".repeat(64), null, idx).chunks).toEqual({
      indexBytes: f.index.byteLength,
      records: idx.records,
    });
  });

  it("stays null without an index, or with null passed explicitly (P4-06's callers)", () => {
    expect(planTarget(variant(), "7".repeat(64), null).chunks).toBeNull();
    expect(planTarget(variant(), "7".repeat(64), null, null).chunks).toBeNull();
  });

  it("a record longer than MAX_CHUNK_BYTES makes the strategy unusable", () => {
    const big = {
      ...idx,
      records: idx.records.map(
        (r, i) =>
          (i === 0
            ? [r[0], MAX_CHUNK_BYTES + 1, r[2], r[3], r[4]]
            : r) as typeof r,
      ),
    };
    expect(planTarget(variant(), "7".repeat(64), null, big).chunks).toBeNull();
    const edge = {
      ...idx,
      records: idx.records.map(
        (r, i) =>
          (i === 0 ? [r[0], MAX_CHUNK_BYTES, r[2], r[3], r[4]] : r) as typeof r,
      ),
    };
    expect(
      planTarget(variant(), "7".repeat(64), null, edge).chunks,
    ).not.toBeNull();
  });

  it("the returned records are copies", () => {
    const t = planTarget(variant(), "7".repeat(64), null, idx);
    t.chunks!.records[0]![1] = 1;
    expect(idx.records[0]![1]).toBe(100);
  });
});

describe("the claims at `chunks` (plans/P4-10.md §2.2, checks 81–83)", () => {
  const record = (chunks: unknown): Record<string, unknown> => ({
    schemaVersion: 1,
    aud: "polaris-key:product:p",
    deliverable: "djdl.levels",
    kind: "pack",
    version: "1.0.0",
    seq: 1,
    issuedAt: 1,
    type: "godot.pck",
    formatVersion: 4,
    variants: [
      {
        variant: {},
        payload: { size: 150, sha256: "a".repeat(64) },
        full: { sha256: "b".repeat(64), bytes: 10, size: 150, codec: "zstd" },
        files: {
          format: "pkey-files/1",
          layout: "container",
          sha256: "c".repeat(64),
          bytes: 10,
          size: 20,
          codec: "zstd",
          gaps: { sha256: "d".repeat(64), bytes: 0, size: 0, codec: "none" },
        },
        ...(chunks === undefined ? {} : { chunks }),
      },
    ],
  });
  const ok = (chunks: unknown): boolean =>
    releaseRecordClaims(record(chunks), {
      expectedAud: "polaris-key:product:p",
    });
  const good = {
    format: CHUNKS_FORMAT,
    sha256: "e".repeat(64),
    bytes: 8,
    size: 9,
    codec: "zstd",
  };

  it("accepts an absent `chunks`, a well-formed one, and unknown members", () => {
    expect(ok(undefined)).toBe(true);
    expect(ok(good)).toBe(true);
    expect(
      ok({ ...good, params: {}, deltas: [], format: "pkey-chunks/9" }),
    ).toBe(true);
  });

  it("refuses a malformed `chunks`", () => {
    expect(ok(null)).toBe(false);
    expect(ok({ ...good, format: "" })).toBe(false);
    expect(ok({ ...good, params: 7 })).toBe(false);
    expect(ok({ ...good, bytes: 0 })).toBe(false);
    expect(ok({ ...good, size: 0 })).toBe(false);
    expect(ok({ ...good, codec: "none" })).toBe(false); // none ⇒ bytes === size
  });
});
