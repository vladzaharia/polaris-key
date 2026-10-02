/**
 * P4-02 — pack fixtures: hand-built pack objects (payloads, `pkey-files/1` indexes stored as zstd
 * frames, gaps, deltas, file blobs) and the `kind: pack` records over them, shaped exactly as
 * plans/P4-01.md §2.3 and §2.7 specify. No zstd encoder is needed: an index is stored as one
 * zstd frame of RAW blocks (RFC 8878 §3.1.1.2), which every decoder, `@polaris-key/zstd-wasm`
 * included, decodes.
 */

import { createHash } from "node:crypto";
import { treeDigest } from "@polaris-key/client-core/packs";

export const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

/** One zstd frame of raw blocks, single-segment, with a 4-byte content size, no checksum. */
export function rawZstdFrame(content: Uint8Array): Uint8Array {
  const MAX_BLOCK = 128 * 1024;
  const parts: number[] = [0x28, 0xb5, 0x2f, 0xfd, 0xa0];
  const n = content.length;
  parts.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  const header = new Uint8Array(parts);
  const blocks: Uint8Array[] = [header];
  let pos = 0;
  do {
    const size = Math.min(MAX_BLOCK, n - pos);
    const last = pos + size >= n ? 1 : 0;
    const h = (size << 3) | last; // block type 0 (raw)
    blocks.push(
      new Uint8Array([h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff]),
    );
    blocks.push(content.subarray(pos, pos + size));
    pos += size;
  } while (pos < n);
  return new Uint8Array(Buffer.concat(blocks));
}

/** Deterministic bytes from a seed string. */
export function bytesFrom(seed: string, n: number): Uint8Array {
  const out = new Uint8Array(n);
  let h = createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i++) {
    if (i % 32 === 0 && i > 0) h = createHash("sha256").update(h).digest();
    out[i] = h[i % 32]!;
  }
  return out;
}

/** A stored object to upload: its bytes and SHA-256. */
export interface Obj {
  bytes: Uint8Array;
  sha256: string;
}
const obj = (bytes: Uint8Array): Obj => ({ bytes, sha256: sha(bytes) });

export interface BuiltVariant {
  variant: Record<string, unknown>;
  /** Every object a stage round must upload for this variant (index, full, gaps, deltas, files). */
  objects: Obj[];
}

/**
 * A `container` variant (a `godot.pck`-shaped payload): two files with a gap before each, the
 * whole payload stored raw as `full`, the index as a raw-block zstd frame, the gaps raw, a
 * `payload` delta and a `files` delta set, and one raw blob per file.
 */
export function containerVariant(
  variant: Record<string, string>,
  seed: string,
  opts: { engine?: string } = {},
): BuiltVariant {
  const gapA = bytesFrom(`${seed}/gapA`, 10);
  const fileA = bytesFrom(`${seed}/a`, 100);
  const gapB = bytesFrom(`${seed}/gapB`, 10);
  const fileB = bytesFrom(`${seed}/b`, 50);
  const payload = new Uint8Array(Buffer.concat([gapA, fileA, gapB, fileB]));
  const full = obj(payload);
  const gaps = obj(new Uint8Array(Buffer.concat([gapA, gapB])));
  const blobA = obj(fileA);
  const blobB = obj(fileB);
  const index = new TextEncoder().encode(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "container",
      payload: { size: payload.length, sha256: full.sha256 },
      files: [
        {
          path: "assets/core/a.bin",
          offset: 10,
          size: fileA.length,
          sha256: blobA.sha256,
          blob: { sha256: blobA.sha256, bytes: fileA.length, codec: "none" },
        },
        {
          path: "assets/core/b.bin",
          offset: 120,
          size: fileB.length,
          sha256: blobB.sha256,
          blob: { sha256: blobB.sha256, bytes: fileB.length, codec: "none" },
        },
      ],
    }),
  );
  const indexObj = obj(rawZstdFrame(index));
  const delta = obj(bytesFrom(`${seed}/delta`, 40));
  const patch = obj(bytesFrom(`${seed}/patch`, 30));
  const data = obj(bytesFrom(`${seed}/data`, 25));
  const from = sha(`${seed}/base`);
  return {
    variant: {
      variant,
      payload: { size: payload.length, sha256: full.sha256 },
      full: {
        sha256: full.sha256,
        bytes: payload.length,
        size: payload.length,
        codec: "none",
      },
      files: {
        format: "pkey-files/1",
        layout: "container",
        sha256: indexObj.sha256,
        bytes: indexObj.bytes.length,
        size: index.length,
        codec: "zstd",
        gaps: {
          sha256: gaps.sha256,
          bytes: gaps.bytes.length,
          size: gaps.bytes.length,
          codec: "none",
        },
      },
      deltas: [
        {
          method: "zstd-patch-from",
          scope: "payload",
          from,
          memBytes: 400,
          artifact: { sha256: delta.sha256, bytes: delta.bytes.length },
        },
        {
          method: "zstd-patch-from",
          scope: "files",
          from,
          memBytes: 200,
          patch: {
            sha256: patch.sha256,
            bytes: patch.bytes.length,
            size: patch.bytes.length,
            codec: "none",
          },
          data: { sha256: data.sha256, bytes: data.bytes.length },
        },
      ],
      ...(opts.engine ? { requires: { engine: opts.engine } } : {}),
    },
    objects: [full, indexObj, gaps, delta, patch, data, blobA, blobB],
  };
}

/** A `tree` variant (a `files.tree` payload): two files, `payload.sha256` their `treeDigest`,
 *  `full` the files concatenated in index order, no gaps, no deltas. */
export async function treeVariant(
  variant: Record<string, string>,
  seed: string,
  paths: readonly [string, string] = ["locale/a.txt", "locale/b.txt"],
): Promise<BuiltVariant> {
  const fileA = bytesFrom(`${seed}/a`, 64);
  const fileB = bytesFrom(`${seed}/b`, 32);
  const entries = [
    { path: paths[0], size: fileA.length, sha256: sha(fileA) },
    { path: paths[1], size: fileB.length, sha256: sha(fileB) },
  ];
  const digest = await treeDigest(entries);
  const full = obj(new Uint8Array(Buffer.concat([fileA, fileB])));
  const index = new TextEncoder().encode(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "tree",
      payload: { size: full.bytes.length, sha256: digest },
      files: entries.map((e) => ({
        ...e,
        blob: { sha256: e.sha256, bytes: e.size, codec: "none" },
      })),
    }),
  );
  const indexObj = obj(rawZstdFrame(index));
  return {
    variant: {
      variant,
      payload: { size: full.bytes.length, sha256: digest },
      full: {
        sha256: full.sha256,
        bytes: full.bytes.length,
        size: full.bytes.length,
        codec: "none",
      },
      files: {
        format: "pkey-files/1",
        layout: "tree",
        sha256: indexObj.sha256,
        bytes: indexObj.bytes.length,
        size: index.length,
        codec: "zstd",
      },
    },
    objects: [full, indexObj, obj(fileA), obj(fileB)],
  };
}

/** A `kind: pack` record over `variants`. */
export function packRecord(r: {
  aud: string;
  deliverable: string;
  version: string;
  seq: number;
  issuedAt: number;
  type: string;
  variants: Record<string, unknown>[];
  entitlement?: string;
  handler?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    aud: r.aud,
    deliverable: r.deliverable,
    kind: "pack",
    version: r.version,
    seq: r.seq,
    issuedAt: r.issuedAt,
    type: r.type,
    formatVersion: r.type === "godot.pck" ? 4 : 1,
    ...(r.handler ? { handler: r.handler } : {}),
    ...(r.entitlement !== undefined ? { entitlement: r.entitlement } : {}),
    variants: r.variants,
  };
}
