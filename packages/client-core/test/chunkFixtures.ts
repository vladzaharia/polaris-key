// Chunk-sync fixtures (P4-11): a `pkey-chunks/1` writer, container pack releases whose payload is
// a list of 64 KiB pseudo-random chunks (raw, `clen == len`), bundles laid out by hand, and a
// fake blob server that answers bounded `Range` requests with `206`, `ETag` and an exact
// `Content-Range`, records every request, and can answer `200` or cut a body short.

import { createHash } from "node:crypto";
import { signJws } from "@polaris-key/jws";
import type { ObjectResponse } from "../src/index.js";
import { PRODUCT, RELEASE_KID } from "./packFixtures.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(
  readFileSync(
    join(here, "..", "..", "..", "conformance", "corpus", "v2", "cases.json"),
    "utf8",
  ),
) as { keys: { kid: string; privateKeyPkcs8Pem: string }[] };
const releasePem = corpus.keys.find(
  (k) => k.kid === RELEASE_KID,
)!.privateKeyPkcs8Pem;

const sha = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export const CHUNK = 64 * 1024;

/** `n` deterministic pseudo-random bytes named by `label` (SHA-256 in counter mode). */
export function chunkBytes(label: string, n = CHUNK): Uint8Array {
  const out = new Uint8Array(n);
  for (let at = 0, i = 0; at < n; i++) {
    const block = createHash("sha256").update(`${label}:${i}`).digest();
    out.set(block.subarray(0, Math.min(32, n - at)), at);
    at += 32;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/** A `pkey-chunks/1` index (plans/P4-10.md §2.3), every u64 written as two u32 words. */
export function writeChunkIndex(
  payload: Uint8Array,
  records: readonly [string, number, number, number, number][],
  bundles: readonly [string, number][],
): Uint8Array {
  const b = new Uint8Array(64 + 48 * (records.length + bundles.length));
  const dv = new DataView(b.buffer);
  b.set(enc("PKEYCHNK"), 0);
  dv.setUint16(8, 1, true);
  dv.setUint16(10, 48, true);
  dv.setUint32(12, 1, true);
  dv.setUint32(16, records.length, true);
  dv.setUint32(20, bundles.length, true);
  dv.setUint32(24, payload.byteLength % 2 ** 32, true);
  dv.setUint32(28, Math.floor(payload.byteLength / 2 ** 32), true);
  b.set(Buffer.from(sha(payload), "hex"), 32);
  records.forEach(([id, len, clen, bundle, offset], i) => {
    const o = 64 + 48 * i;
    b.set(Buffer.from(id, "hex"), o);
    dv.setUint32(o + 32, len, true);
    dv.setUint32(o + 36, clen, true);
    dv.setUint32(o + 40, bundle, true);
    dv.setUint32(o + 44, offset, true);
  });
  bundles.forEach(([h, size], j) => {
    const o = 64 + 48 * (records.length + j);
    b.set(Buffer.from(h, "hex"), o);
    dv.setUint32(o + 32, size % 2 ** 32, true);
    dv.setUint32(o + 36, Math.floor(size / 2 ** 32), true);
  });
  return b;
}

export interface ContainerPack {
  packId: string;
  version: string;
  seq: number;
  jws: string;
  recordSha256: string;
  payload: Uint8Array;
  objects: Map<string, Uint8Array>;
  index: Uint8Array;
  indexSha256: string;
}

/**
 * A container release (`type`, restart) whose payload is `chunks` in order. `bundles` lays out the
 * chunk store: each bundle is a list of chunk labels (or `null` for 64 KiB of filler no record
 * names); every payload chunk must be in some bundle. Its variant carries `chunks` (codec `none`).
 */
export async function containerPack(o: {
  packId: string;
  version: string;
  seq: number;
  type?: string;
  chunks: string[];
  bundles: (string | null)[][];
  /** Extra objects the server holds (earlier bundles shared along the chain). */
  extraObjects?: Map<string, Uint8Array>;
}): Promise<ContainerPack> {
  const bytesOf = new Map<string, Uint8Array>();
  for (const l of o.chunks) bytesOf.set(l, chunkBytes(l));
  const payload = concat(o.chunks.map((l) => bytesOf.get(l)!));
  const objects = new Map<string, Uint8Array>(o.extraObjects ?? []);
  const where = new Map<string, [number, number]>();
  const bundleTable: [string, number][] = [];
  o.bundles.forEach((labels, bi) => {
    const body = concat(
      labels.map((l, k) =>
        l === null ? chunkBytes(`filler:${bi}:${k}`) : chunkBytes(l),
      ),
    );
    labels.forEach((l, k) => {
      if (l !== null && !where.has(l)) where.set(l, [bi, k * CHUNK]);
    });
    objects.set(sha(body), body);
    bundleTable.push([sha(body), body.byteLength]);
  });
  const records = o.chunks.map((l) => {
    const at = where.get(l);
    if (!at) throw new Error(`chunk ${l} is in no bundle`);
    return [sha(bytesOf.get(l)!), CHUNK, CHUNK, at[0], at[1]] as [
      string,
      number,
      number,
      number,
      number,
    ];
  });
  const index = writeChunkIndex(payload, records, bundleTable);
  objects.set(sha(index), index);
  objects.set(sha(payload), payload);
  const filesIndex = enc(
    JSON.stringify({
      format: "pkey-files/1",
      layout: "container",
      payload: { size: payload.byteLength, sha256: sha(payload) },
      files: [
        {
          path: "data.bin",
          offset: 0,
          size: payload.byteLength,
          sha256: sha(payload),
          blob: {
            sha256: sha(payload),
            bytes: payload.byteLength,
            codec: "none",
          },
        },
      ],
    }),
  );
  const gaps = new Uint8Array();
  objects.set(sha(filesIndex), filesIndex);
  objects.set(sha(gaps), gaps);
  const record = {
    schemaVersion: 1,
    aud: PRODUCT,
    deliverable: o.packId,
    kind: "pack",
    version: o.version,
    seq: o.seq,
    issuedAt: 1759300000 + o.seq,
    type: o.type ?? "custom.blob",
    formatVersion: 1,
    handler: { activation: "restart" },
    variants: [
      {
        variant: {},
        payload: { size: payload.byteLength, sha256: sha(payload) },
        full: {
          sha256: sha(payload),
          bytes: payload.byteLength,
          size: payload.byteLength,
          codec: "none",
        },
        files: {
          format: "pkey-files/1",
          layout: "container",
          sha256: sha(filesIndex),
          bytes: filesIndex.byteLength,
          size: filesIndex.byteLength,
          codec: "none",
          gaps: { sha256: sha(gaps), bytes: 0, size: 0, codec: "none" },
        },
        chunks: {
          format: "pkey-chunks/1",
          sha256: sha(index),
          bytes: index.byteLength,
          size: index.byteLength,
          codec: "none",
        },
      },
    ],
  };
  const jws = await signJws(
    record,
    releasePem,
    RELEASE_KID,
    "pkey-release+jws",
  );
  return {
    packId: o.packId,
    version: o.version,
    seq: o.seq,
    jws,
    recordSha256: sha(jws),
    payload,
    objects,
    index,
    indexSha256: sha(index),
  };
}

export interface RangeCall {
  sha256: string;
  offset: number;
  length?: number;
  ifRange: string | null;
}

/** A blob server over records and objects with bounded-range support. */
export function rangeServer(...packs: ContainerPack[]) {
  const records = new Map(packs.map((p) => [p.recordSha256, p.jws]));
  const objects = new Map<string, Uint8Array>();
  for (const p of packs) for (const [h, b] of p.objects) objects.set(h, b);
  const calls: RangeCall[] = [];
  const server = {
    calls,
    /** Answer every bounded range with the whole object and `200`. */
    ignoreRange: false,
    /** Cut the body of the Nth bounded range request (1-based) after half its bytes. */
    cutRange: 0,
    /** Objects answered 404 although the server holds them. */
    missing: new Set<string>(),
    /** Answer bounded ranges with this `ETag` instead of the object's hash. */
    etag: null as string | null,
    ranges: () => calls.filter((c) => c.length !== undefined),
    fetchRecord: async (h: string) => {
      const body = records.get(h);
      return body === undefined
        ? ({ ok: false, code: "not_found" } as const)
        : ({ ok: true, body } as const);
    },
    fetchObject: async (req: RangeCall): Promise<ObjectResponse> => {
      calls.push({ ...req });
      const b = server.missing.has(req.sha256)
        ? undefined
        : objects.get(req.sha256);
      if (!b)
        return {
          status: 404,
          contentRange: null,
          chunks: (async function* () {})(),
        };
      const tag = server.etag ?? `"${req.sha256}"`;
      if (req.length !== undefined) {
        const nth = server.ranges().length;
        if (server.ignoreRange)
          return {
            status: 200,
            contentRange: null,
            etag: tag,
            chunks: (async function* () {
              yield b;
            })(),
          };
        const end = Math.min(req.offset + req.length, b.byteLength) - 1;
        const body = b.subarray(req.offset, end + 1);
        const cut = nth === server.cutRange;
        return {
          status: 206,
          contentRange: `bytes ${req.offset}-${end}/${b.byteLength}`,
          etag: tag,
          chunks: (async function* () {
            if (cut) {
              yield body.subarray(0, body.byteLength >> 1);
              throw new Error("connection reset");
            }
            for (let at = 0; at < body.byteLength; at += 8192)
              yield body.subarray(at, at + 8192);
          })(),
        };
      }
      const ranged = req.offset > 0 && req.ifRange === `"${req.sha256}"`;
      const body = ranged ? b.subarray(req.offset) : b;
      return {
        status: ranged ? 206 : 200,
        contentRange: ranged
          ? `bytes ${req.offset}-${b.byteLength - 1}/${b.byteLength}`
          : null,
        etag: `"${req.sha256}"`,
        chunks: (async function* () {
          yield body;
        })(),
      };
    },
  };
  return server;
}

/** A content stamp pinning these releases. */
export function chunkStamp(...packs: ContainerPack[]) {
  return {
    contentApi: 1,
    pins: packs.map((p) => ({
      pack: p.packId,
      release: { sha256: p.recordSha256, seq: p.seq, version: p.version },
    })),
    expects: packs.map((p) => ({
      pack: p.packId,
      required: true,
      delivery: "essential",
    })),
  };
}

export { sha };
