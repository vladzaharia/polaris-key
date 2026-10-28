// `pkey-sync-file/1` (WIRE-CONTRACT-V5 §13.10.4): a file sealed as a stream of segments.
//
//   header, 64 bytes little-endian: "PKSYNCF1", version u16 (1), flags u16 (0),
//     segmentBytes u32 (1 MiB), kid (16 bytes), salt (32 bytes)
//   segment i: AES-256-GCM(K_file, nonce = u8(last) | 0x00 0x00 0x00 | u64be(i), aad = header,
//     the segment's plaintext), so 16 bytes longer than its plaintext
//
// K_file comes from K_coll and the header's salt (`deriveFileKey`). Every segment but the last
// holds exactly `segmentBytes` of plaintext; the last holds 1..segmentBytes, except that an empty
// file is one empty last segment. The end of the stream says which segment is last, so a
// truncated stream, a dropped or reordered segment and a missing last flag all fail the tag.
//
// Nothing here holds a whole file: the sealer and the opener keep at most one segment and the
// chunk in hand, and a ranged open reads and decrypts only the segments it needs.

import { SYNC_FILE_MAX_BYTES } from "@polaris-key/protocol/sync";
import {
  deriveFileKey,
  SYNC_FILE_SALT_BYTES,
  SYNC_KID_BYTES,
  type SyncCryptoPort,
} from "./crypto.js";
import { Sha256 } from "./sha256.js";

export const FILE_STREAM_MAGIC = "PKSYNCF1";
export const FILE_STREAM_VERSION = 1;
export const FILE_HEADER_BYTES = 64;
/** The only segment size `pkey-sync-file/1` defines. */
export const FILE_SEGMENT_BYTES = 1_048_576;
export const FILE_TAG_BYTES = 16;

/**
 * Why a reader refuses a stream, in the order it checks: the header (`shape`: under 64 bytes;
 * `magic`, `version`, `flags`, `segmentSize`, `kid`), then the body (`shape`: no segment, or a
 * tail shorter than a tag; `size`: an empty last segment after others; `auth`: a segment fails
 * its tag, which covers truncation, reordering, a missing last flag and a tampered header).
 * `range` is a ranged open outside the file; `plainSize` and `plainSha256` are reassembly checks.
 */
export type FileStreamInvalid =
  | "shape"
  | "magic"
  | "version"
  | "flags"
  | "segmentSize"
  | "kid"
  | "size"
  | "auth"
  | "range"
  | "plainSize"
  | "plainSha256";

export class FileStreamError extends Error {
  constructor(readonly reason: FileStreamInvalid) {
    super(`pkey-sync-file/1: ${reason}`);
    this.name = "FileStreamError";
  }
}

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

export function encodeFileHeader(
  kid: Uint8Array,
  salt: Uint8Array,
): Uint8Array {
  if (kid.length !== SYNC_KID_BYTES) throw new RangeError("kid length");
  if (salt.length !== SYNC_FILE_SALT_BYTES) throw new RangeError("salt length");
  const h = new Uint8Array(FILE_HEADER_BYTES);
  const v = new DataView(h.buffer);
  h.set(ascii(FILE_STREAM_MAGIC), 0);
  v.setUint16(8, FILE_STREAM_VERSION, true);
  v.setUint16(10, 0, true);
  v.setUint32(12, FILE_SEGMENT_BYTES, true);
  h.set(kid, 16);
  h.set(salt, 32);
  return h;
}

/** The sealed size of a plaintext of `plainSize` bytes. */
export function sealedFileSize(plainSize: number): number {
  if (!Number.isSafeInteger(plainSize) || plainSize < 0)
    throw new RangeError("plain size");
  const segments = Math.max(1, Math.ceil(plainSize / FILE_SEGMENT_BYTES));
  return FILE_HEADER_BYTES + plainSize + segments * FILE_TAG_BYTES;
}

/** The plaintext size a sealed size implies, or null when no stream has that size. */
export function plainFileSize(sealedSize: number): number | null {
  if (!Number.isSafeInteger(sealedSize)) return null;
  const body = sealedSize - FILE_HEADER_BYTES;
  const whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES;
  if (body < FILE_TAG_BYTES) return null;
  const full = Math.floor(body / whole);
  const rest = body - full * whole;
  if (rest === 0) return full * FILE_SEGMENT_BYTES;
  if (rest < FILE_TAG_BYTES) return null;
  // An empty last segment is only the empty file.
  if (rest === FILE_TAG_BYTES && full > 0) return null;
  return full * FILE_SEGMENT_BYTES + (rest - FILE_TAG_BYTES);
}

function nonce(index: number, last: boolean): Uint8Array {
  const n = new Uint8Array(12);
  n[0] = last ? 1 : 0;
  new DataView(n.buffer).setBigUint64(4, BigInt(index), false);
  return n;
}

/** A FIFO of byte runs: `take(n)` copies the first `n` bytes out. */
class ByteQueue {
  private runs: Uint8Array[] = [];
  length = 0;

  push(b: Uint8Array): void {
    if (b.length === 0) return;
    this.runs.push(b);
    this.length += b.length;
  }

  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const run = this.runs[0]!;
      const want = Math.min(n - at, run.length);
      out.set(run.subarray(0, want), at);
      at += want;
      if (want === run.length) this.runs.shift();
      else this.runs[0] = run.subarray(want);
    }
    this.length -= n;
    return out;
  }
}

export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

/**
 * Seals `source` as a `pkey-sync-file/1` stream, yielding the header and then one sealed segment
 * at a time. `kid` is `deriveKid(root)`, `collKey` is `K_coll`, and `salt` is 32 fresh random
 * bytes: a salt names one file version, so reusing it under the same `collKey` repeats the key
 * and the nonces.
 */
export async function* sealFileStream(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  salt: Uint8Array,
  source: ByteSource,
): AsyncGenerator<Uint8Array> {
  const header = encodeFileHeader(kid, salt);
  const key = await deriveFileKey(port, collKey, salt);
  yield header;
  const queue = new ByteQueue();
  let index = 0;
  for await (const part of source) {
    queue.push(part);
    // Hold one byte back so the final segment is known to be last.
    while (queue.length > FILE_SEGMENT_BYTES) {
      yield port.aesGcmSeal(
        key,
        nonce(index++, false),
        header,
        queue.take(FILE_SEGMENT_BYTES),
      );
    }
  }
  yield port.aesGcmSeal(
    key,
    nonce(index, true),
    header,
    queue.take(queue.length),
  );
}

/** `sealFileStream` over one buffer, concatenated. For files that fit in memory. */
export async function sealFile(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  salt: Uint8Array,
  plain: Uint8Array,
): Promise<Uint8Array> {
  const out = new Uint8Array(sealedFileSize(plain.length));
  let at = 0;
  for await (const part of sealFileStream(port, collKey, kid, salt, [plain])) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface ParsedHeader {
  header: Uint8Array;
  salt: Uint8Array;
}

function parseHeader(b: Uint8Array, kid: Uint8Array): ParsedHeader {
  if (b.length < FILE_HEADER_BYTES) throw new FileStreamError("shape");
  for (let i = 0; i < 8; i++)
    if (b[i] !== FILE_STREAM_MAGIC.charCodeAt(i))
      throw new FileStreamError("magic");
  const v = new DataView(b.buffer, b.byteOffset, FILE_HEADER_BYTES);
  if (v.getUint16(8, true) !== FILE_STREAM_VERSION)
    throw new FileStreamError("version");
  if (v.getUint16(10, true) !== 0) throw new FileStreamError("flags");
  if (v.getUint32(12, true) !== FILE_SEGMENT_BYTES)
    throw new FileStreamError("segmentSize");
  let diff = kid.length ^ SYNC_KID_BYTES;
  for (let i = 0; i < SYNC_KID_BYTES; i++)
    diff |= (b[16 + i] ?? 0) ^ (kid[i] ?? 0);
  if (diff !== 0) throw new FileStreamError("kid");
  return {
    header: Uint8Array.from(b.subarray(0, FILE_HEADER_BYTES)),
    salt: Uint8Array.from(b.subarray(32, FILE_HEADER_BYTES)),
  };
}

/**
 * Opens a sealed stream, yielding each segment's plaintext once its tag has verified. Throws
 * `FileStreamError`. Truncation is only known at the end, so a caller that writes the plaintext
 * out treats it as provisional until the generator finishes without throwing.
 * `kid` is `deriveKid(root)`; a stream sealed under another ring is refused as `kid`.
 */
export async function* openFileStream(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  source: ByteSource,
): AsyncGenerator<Uint8Array> {
  const queue = new ByteQueue();
  const it = (
    Symbol.asyncIterator in source
      ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (source as Iterable<Uint8Array>)[Symbol.iterator]()
  ) as AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
  let ended = false;
  const fill = async (until: number): Promise<void> => {
    while (!ended && queue.length < until) {
      const r = await it.next();
      if (r.done) ended = true;
      else queue.push(r.value);
    }
  };

  await fill(FILE_HEADER_BYTES);
  if (queue.length < FILE_HEADER_BYTES) throw new FileStreamError("shape");
  const { header, salt } = parseHeader(queue.take(FILE_HEADER_BYTES), kid);
  const key = await deriveFileKey(port, collKey, salt);
  const whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES;

  let index = 0;
  for (;;) {
    // One byte beyond a whole segment proves the segment is not the last.
    await fill(whole + 1);
    if (queue.length > whole) {
      const plain = await port.aesGcmOpen(
        key,
        nonce(index, false),
        header,
        queue.take(whole),
      );
      if (plain === null) throw new FileStreamError("auth");
      yield plain;
      index++;
      continue;
    }
    if (queue.length < FILE_TAG_BYTES) throw new FileStreamError("shape");
    if (queue.length === FILE_TAG_BYTES && index > 0)
      throw new FileStreamError("size");
    const plain = await port.aesGcmOpen(
      key,
      nonce(index, true),
      header,
      queue.take(queue.length),
    );
    if (plain === null) throw new FileStreamError("auth");
    yield plain;
    return;
  }
}

/** `openFileStream` over one buffer, concatenated; null is a refusal, with `reason`. */
export async function openFile(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  sealed: Uint8Array,
): Promise<
  { ok: true; plain: Uint8Array } | { ok: false; reason: FileStreamInvalid }
> {
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for await (const p of openFileStream(port, collKey, kid, [sealed])) {
      parts.push(p);
      n += p.length;
    }
  } catch (e) {
    if (e instanceof FileStreamError) return { ok: false, reason: e.reason };
    throw e;
  }
  const plain = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    plain.set(p, at);
    at += p.length;
  }
  return { ok: true, plain };
}

/** Reads `length` bytes of the stored file at `offset`; a short answer is a `size` refusal. */
export type RangeReader = (
  offset: number,
  length: number,
) => Promise<Uint8Array>;

/**
 * Opens bytes `[start, end)` of the plaintext of a stored stream of `sealedSize` bytes, yielding
 * the pieces in order. It reads the header and then only the segments that overlap the range,
 * each verified as a whole; the last-segment flag comes from `sealedSize`, so a server that lies
 * about the size or drops a tail fails the tag. `end` is clamped to nothing: past the plaintext
 * size is `range`.
 */
export async function* openFileRangeStream(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  read: RangeReader,
  sealedSize: number,
  start: number,
  end: number,
): AsyncGenerator<Uint8Array> {
  const plainSize = plainFileSize(sealedSize);
  if (plainSize === null) throw new FileStreamError("shape");
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    end > plainSize
  )
    throw new FileStreamError("range");

  const fetch = async (offset: number, length: number): Promise<Uint8Array> => {
    const b = await read(offset, length);
    if (b.length !== length) throw new FileStreamError("size");
    return b;
  };
  const { header, salt } = parseHeader(await fetch(0, FILE_HEADER_BYTES), kid);
  if (start === end) return;
  const key = await deriveFileKey(port, collKey, salt);

  const whole = FILE_SEGMENT_BYTES + FILE_TAG_BYTES;
  const segments = Math.max(1, Math.ceil(plainSize / FILE_SEGMENT_BYTES));
  const first = Math.floor(start / FILE_SEGMENT_BYTES);
  const last = Math.floor((end - 1) / FILE_SEGMENT_BYTES);
  for (let i = first; i <= last; i++) {
    const isLast = i === segments - 1;
    const plainLen = isLast
      ? plainSize - i * FILE_SEGMENT_BYTES
      : FILE_SEGMENT_BYTES;
    const sealed = await fetch(
      FILE_HEADER_BYTES + i * whole,
      plainLen + FILE_TAG_BYTES,
    );
    const plain = await port.aesGcmOpen(key, nonce(i, isLast), header, sealed);
    if (plain === null) throw new FileStreamError("auth");
    const from =
      Math.max(start, i * FILE_SEGMENT_BYTES) - i * FILE_SEGMENT_BYTES;
    const to =
      Math.min(end, i * FILE_SEGMENT_BYTES + plainLen) - i * FILE_SEGMENT_BYTES;
    yield plain.subarray(from, to);
  }
}

/** `openFileRangeStream`, concatenated. */
export async function openFileRange(
  port: SyncCryptoPort,
  collKey: Uint8Array,
  kid: Uint8Array,
  read: RangeReader,
  sealedSize: number,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of openFileRangeStream(
    port,
    collKey,
    kid,
    read,
    sealedSize,
    start,
    end,
  ))
    parts.push(p);
  const out = new Uint8Array(end - start);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Passes the plaintext of a reassembled file through while hashing it, and at the end checks the
 * length and SHA-256 the chunk manifest declared (`ChunkManifest.plainSize` / `plainSha256`).
 * Throws `plainSize` or `plainSha256` after the last piece; the caller discards what it wrote
 * (a file is not usable until this generator finishes). Never holds the file.
 */
export async function* verifyReassembly(
  source: ByteSource,
  expected: { plainSize: number; plainSha256: Uint8Array },
): AsyncGenerator<Uint8Array> {
  if (expected.plainSize > SYNC_FILE_MAX_BYTES)
    throw new FileStreamError("plainSize");
  const hash = new Sha256();
  let n = 0;
  for await (const part of source) {
    n += part.length;
    // Stop a source that overruns before it can write the rest of a runaway file.
    if (n > expected.plainSize) throw new FileStreamError("plainSize");
    hash.update(part);
    yield part;
  }
  if (n !== expected.plainSize) throw new FileStreamError("plainSize");
  const got = hash.digest();
  let diff = got.length ^ expected.plainSha256.length;
  for (let i = 0; i < got.length; i++)
    diff |= got[i]! ^ (expected.plainSha256[i] ?? 0);
  if (diff !== 0) throw new FileStreamError("plainSha256");
}
