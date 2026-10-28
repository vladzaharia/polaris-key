// `pkey-sync-chunks/1` (WIRE-CONTRACT-V5 §13.8.3): the file of a `chunks` upload, a manifest over
// content-defined chunks. It is stored sealed as a `pkey-sync-file/1` stream; this is the
// plaintext inside.
//
//   header, 64 bytes little-endian: "PKSYNCCH", version u16 (1), recordSize u16 (48),
//     flags u32 (0), chunkCount u32, reserved u32 (0), plainSize u64, plainSha256 (32 bytes)
//   record, 48 bytes: id (32 bytes) | plainLen u32 | flags u32 (0) | reserved u64 (0)
//
// A reader refuses the first violation, in the order of `ManifestInvalid`. The plaintext hash
// binds the reassembled file and is checked by whoever reassembles it; a manifest alone cannot.

import {
  SYNC_CDC_MAX_BYTES,
  SYNC_FILE_MAX_BYTES,
  SYNC_MAX_CHUNKS_PER_FILE,
} from "@polaris-key/protocol/sync";

export const MANIFEST_MAGIC = "PKSYNCCH";
export const MANIFEST_VERSION = 1;
export const MANIFEST_HEADER_BYTES = 64;
export const MANIFEST_RECORD_BYTES = 48;

export interface ManifestRecord {
  /** 32 raw bytes. */
  id: Uint8Array;
  plainLen: number;
}

export interface ChunkManifest {
  plainSize: number;
  /** 32 bytes. */
  plainSha256: Uint8Array;
  records: ManifestRecord[];
}

/**
 * In the order a reader checks: the header (`shape`, `magic`, `version`, `recordSize`, `flags`,
 * `reserved`), the declared `count` (over `SYNC_MAX_CHUNKS_PER_FILE`), the byte `length`, a
 * `plainSize` over `SYNC_FILE_MAX_BYTES`, each record in file order (`record`: its flags or
 * reserved are not zero; `chunkLen`: its length is 0 or over `SYNC_CDC_MAX_BYTES`), and last
 * `size`: the lengths do not add up to `plainSize`.
 */
export type ManifestInvalid =
  | "shape"
  | "magic"
  | "version"
  | "recordSize"
  | "flags"
  | "reserved"
  | "count"
  | "length"
  | "size"
  | "record"
  | "chunkLen";

export type ParsedManifest =
  | { ok: true; manifest: ChunkManifest }
  | { ok: false; reason: ManifestInvalid };

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

function putLe(b: Uint8Array, at: number, bytes: number, n: number): void {
  let v = n;
  for (let i = 0; i < bytes; i++) {
    b[at + i] = v % 256;
    v = Math.floor(v / 256);
  }
}

function getLe(b: Uint8Array, at: number, bytes: number): number {
  let v = 0;
  for (let i = bytes - 1; i >= 0; i--) v = v * 256 + b[at + i]!;
  return v;
}

export function encodeManifest(m: ChunkManifest): Uint8Array {
  if (m.plainSha256.length !== 32) throw new RangeError("plainSha256 length");
  if (!Number.isSafeInteger(m.plainSize) || m.plainSize < 0)
    throw new RangeError("plainSize");
  const out = new Uint8Array(
    MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * m.records.length,
  );
  out.set(ascii(MANIFEST_MAGIC));
  putLe(out, 8, 2, MANIFEST_VERSION);
  putLe(out, 10, 2, MANIFEST_RECORD_BYTES);
  putLe(out, 16, 4, m.records.length);
  putLe(out, 24, 8, m.plainSize);
  out.set(m.plainSha256, 32);
  m.records.forEach((r, i) => {
    if (r.id.length !== 32) throw new RangeError("chunk id length");
    const at = MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * i;
    out.set(r.id, at);
    putLe(out, at + 32, 4, r.plainLen);
  });
  return out;
}

export function parseManifest(b: Uint8Array): ParsedManifest {
  const fail = (reason: ManifestInvalid): ParsedManifest => ({
    ok: false,
    reason,
  });
  if (b.length < MANIFEST_HEADER_BYTES) return fail("shape");
  const magic = ascii(MANIFEST_MAGIC);
  for (let i = 0; i < 8; i++) if (b[i] !== magic[i]) return fail("magic");
  if (getLe(b, 8, 2) !== MANIFEST_VERSION) return fail("version");
  if (getLe(b, 10, 2) !== MANIFEST_RECORD_BYTES) return fail("recordSize");
  if (getLe(b, 12, 4) !== 0) return fail("flags");
  if (getLe(b, 20, 4) !== 0) return fail("reserved");
  const count = getLe(b, 16, 4);
  if (count > SYNC_MAX_CHUNKS_PER_FILE) return fail("count");
  if (b.length !== MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * count)
    return fail("length");
  const plainSize = getLe(b, 24, 8);
  if (plainSize > SYNC_FILE_MAX_BYTES) return fail("size");
  const records: ManifestRecord[] = [];
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const at = MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * i;
    if (getLe(b, at + 36, 4) !== 0 || getLe(b, at + 40, 8) !== 0)
      return fail("record");
    const plainLen = getLe(b, at + 32, 4);
    if (plainLen === 0 || plainLen > SYNC_CDC_MAX_BYTES)
      return fail("chunkLen");
    sum += plainLen;
    records.push({ id: b.slice(at, at + 32), plainLen });
  }
  if (sum !== plainSize) return fail("size");
  return {
    ok: true,
    manifest: { plainSize, plainSha256: b.slice(32, 64), records },
  };
}
