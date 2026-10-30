// What the transfer engine needs to know about how a collection stores its files (U-22.2): the
// chunk ids, the chunk objects, and the stored form of a manifest or a whole file. The engine
// moves stored bytes and checks hashes; a `FileCodec` is the one place that knows whether those
// bytes are sealed.
//
//   e2eFileCodec     ids are HMAC-SHA256 under K_cid(c); chunks are `pkey-sync-chunk/1` objects
//                    (§13.8.3); a manifest and a whole file are `pkey-sync-file/1` streams
//   serverFileCodec  ids are the plain SHA-256; a chunk object is `0x00 | codec | body` (D-5,
//                    U-37.0); a manifest and a file are stored as they are
//
// Writers emit codec 0 (raw) chunks only (D-4); readers decode codecs 0 and 1. A stored chunk is
// at most `SERVER_CHUNK_MAX_STORED_BYTES` (D-5: 1 MiB plus 30). The server-mode object is not in
// the corpus yet; U-37.0 pins it, and these functions follow that decision.

import { SYNC_CDC_MAX_BYTES } from "@polaris-key/protocol/sync";
import {
  CHUNK_CODEC_RAW,
  CHUNK_CODEC_ZSTD,
  chunkId as computeChunkId,
  openChunk as openE2eChunk,
  sealChunk as sealE2eChunk,
  decodeZstdChunk,
  type ChunkInvalid,
  type ChunkZstdDecode,
} from "./chunks.js";
import { deriveCollKey, deriveKid, type SyncCryptoPort } from "./crypto.js";
import {
  openFile,
  openFileStream,
  plainFileSize,
  sealedFileSize,
  sealFile,
  type ByteSource,
  type FileStreamInvalid,
} from "./fileStream.js";

/** D-5: the largest stored chunk object, 1 MiB of body plus the 30 bytes of the E2E layout. */
export const SERVER_CHUNK_MAX_STORED_BYTES = SYNC_CDC_MAX_BYTES + 30;

/** The version byte of a server-mode chunk object. */
export const SERVER_CHUNK_OBJECT_VERSION = 0x00;

export type OpenedStoredChunk =
  | { ok: true; plain: Uint8Array }
  | { ok: false; reason: ChunkInvalid };

export type OpenedStoredFile =
  | { ok: true; plain: Uint8Array }
  | { ok: false; reason: FileStreamInvalid };

export interface FileCodec {
  /** What `begin` calls it. */
  readonly enc: "e2e" | "none";
  /** The 32 raw bytes of a plaintext chunk's id. */
  chunkId(plain: Uint8Array): Promise<Uint8Array>;
  /** The size of the raw (codec 0) object for a chunk of `plainLen` bytes. */
  chunkObjectBytes(plainLen: number): number;
  /** The stored object of a chunk, codec 0. */
  sealChunk(id: Uint8Array, plain: Uint8Array): Promise<Uint8Array>;
  /** Opens a stored object for `id`: every check of the format, the id of the plaintext last. */
  openChunk(id: Uint8Array, object: Uint8Array): Promise<OpenedStoredChunk>;
  /** The stored form of a file of `plainSize` bytes, as `begin` declares it. */
  storedSize(plainSize: number): number;
  /** The plaintext size a stored size implies, or null when none does. */
  plainSize(storedSize: number): number | null;
  /** The stored form of a manifest. */
  sealManifest(plain: Uint8Array): Promise<Uint8Array>;
  openManifest(stored: Uint8Array): Promise<OpenedStoredFile>;
  /** The plaintext of a whole stored file, piece by piece; throws `FileStreamError`. A piece is provisional until the generator ends. */
  openStream(stored: ByteSource): AsyncGenerator<Uint8Array>;
}

/** Constant-time equality of two byte strings. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  let d = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ (b[i] ?? 0);
  return d === 0;
};

/** The codec of a collection of an end-to-end product. `root` is the ring root. */
export function e2eFileCodec(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  decode?: ChunkZstdDecode,
): FileCodec {
  let keys: Promise<{ coll: Uint8Array; kid: Uint8Array }> | null = null;
  const material = () =>
    (keys ??= Promise.all([
      deriveCollKey(port, root, collection),
      deriveKid(port, root),
    ]).then(([coll, kid]) => ({ coll, kid })));
  return {
    enc: "e2e",
    chunkId: (plain) => computeChunkId(port, root, collection, plain),
    chunkObjectBytes: (n) => n + 30,
    sealChunk: (id, plain) =>
      sealE2eChunk(port, root, collection, id, CHUNK_CODEC_RAW, plain),
    async openChunk(id, object) {
      const r = await openE2eChunk(port, root, collection, id, object, decode);
      return r.ok ? { ok: true, plain: r.plain } : r;
    },
    storedSize: sealedFileSize,
    plainSize: plainFileSize,
    async sealManifest(plain) {
      const { coll, kid } = await material();
      return sealFile(port, coll, kid, plain);
    },
    async openManifest(stored) {
      const { coll, kid } = await material();
      return openFile(port, coll, kid, stored);
    },
    async *openStream(stored) {
      const { coll, kid } = await material();
      yield* openFileStream(port, coll, kid, stored);
    },
  };
}

/** The codec of a collection of a server-mode product. */
export function serverFileCodec(
  port: SyncCryptoPort,
  decode?: ChunkZstdDecode,
): FileCodec {
  return {
    enc: "none",
    chunkId: (plain) => port.sha256(plain),
    chunkObjectBytes: (n) => n + 2,
    async sealChunk(id, plain) {
      if (id.length !== 32) throw new RangeError("chunk id length");
      const out = new Uint8Array(2 + plain.length);
      out[0] = SERVER_CHUNK_OBJECT_VERSION;
      out[1] = CHUNK_CODEC_RAW;
      out.set(plain, 2);
      return out;
    },
    async openChunk(id, object) {
      if (object.length < 2) return { ok: false, reason: "shape" };
      if (object.length > SERVER_CHUNK_MAX_STORED_BYTES)
        return { ok: false, reason: "size" };
      if (object[0] !== SERVER_CHUNK_OBJECT_VERSION)
        return { ok: false, reason: "version" };
      const codec = object[1]!;
      if (codec !== CHUNK_CODEC_RAW && codec !== CHUNK_CODEC_ZSTD)
        return { ok: false, reason: "codec" };
      const body = object.subarray(2);
      let plain: Uint8Array;
      if (codec === CHUNK_CODEC_RAW) plain = body;
      else {
        const d = await decodeZstdChunk(body, decode);
        if (!d.ok) return d;
        plain = d.plain;
      }
      if (plain.length > SYNC_CDC_MAX_BYTES)
        return { ok: false, reason: "size" };
      if (!bytesEqual(await port.sha256(plain), id))
        return { ok: false, reason: "id" };
      return { ok: true, plain };
    },
    storedSize: (n) => n,
    plainSize: (n) => n,
    sealManifest: async (plain) => plain,
    openManifest: async (stored) => ({ ok: true, plain: stored }),
    async *openStream(stored) {
      for await (const piece of stored) yield piece;
    },
  };
}
