// Chunk ids and chunk objects (WIRE-CONTRACT-V5 §13.8.3, §13.10.2).
//
//   id      E2E: HMAC-SHA256(K_cid(c), plainChunk); server mode: SHA-256(plainChunk). Hex on the
//           wire (`SYNC_CHUNK_ID_PATTERN`), 32 raw bytes as a key salt and in the aad.
//   object  `pkey-sync-chunk/1`: 0x01 | codec | nonce(12) | AES-256-GCM(K_chunk(id), nonce,
//           aad = 0x01 | codec | id, body). codec 0 is the chunk as is, codec 1 is one zstd frame
//           that declares its content size. A writer may compress; a reader decodes both.
//           K_chunk is per chunk id, but one id can be sealed with different bodies (raw or
//           zstd, or two encoders), so the nonce is synthetic: HMAC-SHA256(K_chunk,
//           0x01 | codec | body)[0:12]. The same key and nonce then imply the same body. The
//           reader takes the nonce from the object and recomputes it after the tag opens.

import { SYNC_CDC_MAX_BYTES } from "@polaris-key/protocol/sync";
import {
  deriveChunkIdKey,
  deriveChunkKey,
  deriveCollKey,
  type SyncCryptoPort,
} from "./crypto.js";

export const CHUNK_OBJECT_VERSION = 0x01;
export const CHUNK_CODEC_RAW = 0;
export const CHUNK_CODEC_ZSTD = 1;
/** Version, codec, nonce and the tag: the smallest object (an empty body). */
export const CHUNK_OBJECT_MIN_BYTES = 2 + 12 + 16;
const NONCE_BYTES = 12;

async function syntheticNonce(
  port: SyncCryptoPort,
  key: Uint8Array,
  codec: number,
  body: Uint8Array,
): Promise<Uint8Array> {
  const msg = new Uint8Array(2 + body.length);
  msg[0] = CHUNK_OBJECT_VERSION;
  msg[1] = codec;
  msg.set(body, 2);
  return (await port.hmac(key, msg)).subarray(0, NONCE_BYTES);
}

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** 32 raw bytes of a chunk id, or null when the text is not 64 lowercase hex characters. */
export function chunkIdBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (x) => Number.parseInt(x, 16));
}

/**
 * The id of a plaintext chunk. `root` is the ring root in E2E mode; `null` is server mode, where
 * the id is the plain SHA-256.
 */
export async function chunkId(
  port: SyncCryptoPort,
  root: Uint8Array | null,
  collection: string,
  plain: Uint8Array,
): Promise<Uint8Array> {
  if (root === null) return port.sha256(plain);
  return port.hmac(await deriveChunkIdKey(port, root, collection), plain);
}

/** `chunkId` as the 64-character hex of the wire. */
export async function chunkIdHex(
  port: SyncCryptoPort,
  root: Uint8Array | null,
  collection: string,
  plain: Uint8Array,
): Promise<string> {
  return toHex(await chunkId(port, root, collection, plain));
}

/**
 * Seals `body` (the chunk for codec 0, one zstd frame for codec 1) as the object for `id`.
 * The caller computed `id` from the plaintext; `openChunk` checks it again.
 */
export async function sealChunk(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  id: Uint8Array,
  codec: number,
  body: Uint8Array,
): Promise<Uint8Array> {
  if (id.length !== 32) throw new RangeError("chunk id length");
  if (codec !== CHUNK_CODEC_RAW && codec !== CHUNK_CODEC_ZSTD)
    throw new RangeError("chunk codec");
  const aad = new Uint8Array(34);
  aad[0] = CHUNK_OBJECT_VERSION;
  aad[1] = codec;
  aad.set(id, 2);
  const key = await deriveChunkKey(
    port,
    await deriveCollKey(port, root, collection),
    id,
  );
  const nonce = await syntheticNonce(port, key, codec, body);
  const ct = await port.aesGcmSeal(key, nonce, aad, body);
  const out = new Uint8Array(2 + NONCE_BYTES + ct.length);
  out.set(aad.subarray(0, 2));
  out.set(nonce, 2);
  out.set(ct, 2 + NONCE_BYTES);
  return out;
}

/** Why a reader refuses a chunk object, in the order it checks. */
export type ChunkInvalid =
  | "shape"
  | "version"
  | "codec"
  | "auth"
  | "nonce"
  | "decode"
  | "size"
  | "id";

export type OpenedChunk =
  | { ok: true; plain: Uint8Array; codec: number }
  | { ok: false; reason: ChunkInvalid };

/** A zstd decoder for one frame with its content size (`@polaris-key/zstd-wasm`'s `decode`).
 *  It may throw; any failure is `decode`. */
export type ChunkZstdDecode = (
  frame: Uint8Array,
  size: number,
) => Uint8Array | Promise<Uint8Array>;

/**
 * The content size a zstd frame header declares (RFC 8878 §3.1.1.1), or null when the frame does
 * not start with the magic, is cut short or declares none.
 */
export function zstdContentSize(f: Uint8Array): number | null {
  if (
    f.length < 6 ||
    f[0] !== 0x28 ||
    f[1] !== 0xb5 ||
    f[2] !== 0x2f ||
    f[3] !== 0xfd
  )
    return null;
  const d = f[4]!;
  const flag = d >>> 6;
  const single = (d >>> 5) & 1;
  const at = 5 + (single === 1 ? 0 : 1) + [0, 1, 2, 4][d & 3]!;
  const width = flag === 0 ? (single === 1 ? 1 : 0) : [0, 2, 4, 8][flag]!;
  if (width === 0 || f.length < at + width) return null;
  let v = 0;
  for (let i = width - 1; i >= 0; i--) v = v * 256 + f[at + i]!;
  return flag === 1 ? v + 256 : v;
}

/**
 * Decodes the body of a codec 1 chunk: one zstd frame whose declared content size (at most
 * `SYNC_CDC_MAX_BYTES`) is checked before anything is decoded, so a bomb costs nothing. `decode`
 * absent, a frame with no declared size, a throw and an answer of another length are `decode`.
 */
export async function decodeZstdChunk(
  body: Uint8Array,
  decode?: ChunkZstdDecode,
): Promise<
  { ok: true; plain: Uint8Array } | { ok: false; reason: "decode" | "size" }
> {
  const size = zstdContentSize(body);
  if (size === null || decode === undefined)
    return { ok: false, reason: "decode" };
  if (size > SYNC_CDC_MAX_BYTES) return { ok: false, reason: "size" };
  let plain: Uint8Array;
  try {
    plain = await decode(body, size);
  } catch {
    return { ok: false, reason: "decode" };
  }
  if (plain.length !== size) return { ok: false, reason: "decode" };
  return { ok: true, plain };
}

/**
 * Opens the object for `id` in `collection`. The checks run in the order of `ChunkInvalid`:
 * shape, version, codec, the tag (which covers the codec and the id), the zstd frame (it must
 * declare a content size of at most `SYNC_CDC_MAX_BYTES`, or `size`), and last that the keyed
 * hash of the plaintext is `id`. A codec 1 object needs `decode`; without one it is `decode`.
 */
export async function openChunk(
  port: SyncCryptoPort,
  root: Uint8Array,
  collection: string,
  id: Uint8Array,
  object: Uint8Array,
  decode?: ChunkZstdDecode,
): Promise<OpenedChunk> {
  if (object.length < CHUNK_OBJECT_MIN_BYTES)
    return { ok: false, reason: "shape" };
  if (object[0] !== CHUNK_OBJECT_VERSION)
    return { ok: false, reason: "version" };
  const codec = object[1]!;
  if (codec !== CHUNK_CODEC_RAW && codec !== CHUNK_CODEC_ZSTD)
    return { ok: false, reason: "codec" };
  if (id.length !== 32) return { ok: false, reason: "auth" };
  const aad = new Uint8Array(34);
  aad.set(object.subarray(0, 2));
  aad.set(id, 2);
  const key = await deriveChunkKey(
    port,
    await deriveCollKey(port, root, collection),
    id,
  );
  const nonce = object.subarray(2, 2 + NONCE_BYTES);
  const body = await port.aesGcmOpen(
    key,
    nonce,
    aad,
    object.subarray(2 + NONCE_BYTES),
  );
  if (body === null) return { ok: false, reason: "auth" };
  const want = await syntheticNonce(port, key, codec, body);
  let nd = 0;
  for (let i = 0; i < NONCE_BYTES; i++) nd |= want[i]! ^ nonce[i]!;
  if (nd !== 0) return { ok: false, reason: "nonce" };

  let plain: Uint8Array;
  if (codec === CHUNK_CODEC_RAW) {
    plain = body;
  } else {
    const d = await decodeZstdChunk(body, decode);
    if (!d.ok) return d;
    plain = d.plain;
  }
  if (plain.length > SYNC_CDC_MAX_BYTES) return { ok: false, reason: "size" };
  const got = await chunkId(port, root, collection, plain);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= got[i]! ^ id[i]!;
  if (diff !== 0) return { ok: false, reason: "id" };
  return { ok: true, plain, codec };
}
