// `pkey-patch/1`, the descriptor of a `files`-scope delta set (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6), and the one object-ref opener every applier shares.

import {
  MAX_FILES_INDEX_BYTES,
  MAX_INDEX_FILES,
  PATCH_FORMAT,
} from "@polaris-key/protocol/core";
import type {
  FilesDelta,
  FilesIndexDoc,
  ObjectRef,
  PatchDoc,
} from "@polaris-key/protocol/packs";
import { isWireInteger } from "../claims.js";
import { SHA256_RE, isObject } from "./claims.js";
import { strictParse } from "./files.js";
import {
  readAll,
  sha256Of,
  type ByteSource,
  type Sha256Port,
  type ZstdPort,
} from "./ports.js";

/**
 * A stored object against its ref, then its decoded bytes (§2.7 step 1): the stored length and
 * SHA-256 must equal the ref's, the codec be `zstd` (decoded to exactly `size`) or `none`. Null
 * on any failure, the caller's code. `maxSize`, when given, refuses a larger `ref.size` before a
 * byte is read.
 */
export async function openObject(
  stored: ByteSource | null,
  ref: Pick<ObjectRef, "sha256" | "bytes" | "size" | "codec">,
  ports: { zstd: Pick<ZstdPort, "decode">; sha256: Sha256Port },
  maxSize?: number,
): Promise<Uint8Array | null> {
  if (stored === null) return null;
  if (maxSize !== undefined && !(ref.size <= maxSize)) return null;
  if (ref.codec !== "zstd" && ref.codec !== "none") return null;
  if (stored.size !== ref.bytes) return null;
  const bytes = await readAll(stored);
  if (bytes.byteLength !== ref.bytes) return null;
  if ((await sha256Of(ports.sha256, bytes)) !== ref.sha256) return null;
  let out: Uint8Array;
  if (ref.codec === "none") out = bytes;
  else {
    try {
      out = await ports.zstd.decode(bytes, ref.size);
    } catch {
      return null;
    }
  }
  return out instanceof Uint8Array && out.byteLength === ref.size ? out : null;
}

/**
 * `parsePatch(stored, delta, targetPayloadSha256, targetIndex)` (§2.7): the descriptor of a
 * `files` delta set, or null — the caller's `delta-artifact-mismatch`. Refused: a descriptor
 * whose `patch` ref fails `openObject` (`MAX_FILES_INDEX_BYTES` included), that is not strict
 * JSON or breaks the integer rule, whose `format`, `scope`, `method`, `from`, `to` or `data`
 * differ from the record's delta and the target, or whose entries break the member rules: each
 * a path of the target index at most once, in target index order, `to` and `size` equal to that
 * entry's, `offset` and `length` integers whose ranges follow the layout rule and end within
 * `data.bytes`, `from` 64 lowercase hex on a `delta` entry, `codec` `zstd` or `none` (with
 * `length === size`) on a `blob` entry. Never throws.
 */
export async function parsePatch(
  stored: ByteSource | null,
  delta: FilesDelta,
  targetPayloadSha256: string,
  target: FilesIndexDoc,
  ports: { zstd: Pick<ZstdPort, "decode">; sha256: Sha256Port },
): Promise<PatchDoc | null> {
  try {
    const pr = delta.patch;
    const data = delta.data;
    const decoded = await openObject(stored, pr, ports, MAX_FILES_INDEX_BYTES);
    if (decoded === null) return null;
    const parsed = strictParse(decoded);
    if (parsed === null) return null;
    const { value: doc, nonWire } = parsed;
    if (!isObject(doc)) return null;
    if (doc.format !== PATCH_FORMAT || doc.scope !== "files") return null;
    if (doc.method !== delta.method || doc.from !== delta.from) return null;
    if (doc.to !== targetPayloadSha256) return null;
    const d = doc.data;
    if (!isObject(d) || d.sha256 !== data.sha256) return null;
    if (!isWireInteger(d.bytes, "/data/bytes", 0, nonWire)) return null;
    if (d.bytes !== data.bytes) return null;
    const list = doc.entries;
    if (!Array.isArray(list) || list.length > MAX_INDEX_FILES) return null;
    const byPath = new Map(target.files.map((f, i) => [f.path, i]));
    const seen = new Set<string>();
    let lastIndex = -1;
    let end = 0;
    for (const [i, e] of list.entries()) {
      const at = `/entries/${i}`;
      if (!isObject(e) || typeof e.path !== "string" || seen.has(e.path))
        return null;
      seen.add(e.path);
      const ti = byPath.get(e.path);
      if (ti === undefined || ti <= lastIndex) return null;
      lastIndex = ti;
      const tf = target.files[ti]!;
      if (e.to !== tf.sha256) return null;
      if (!isWireInteger(e.size, `${at}/size`, 0, nonWire)) return null;
      if (e.size !== tf.size) return null;
      if (!isWireInteger(e.offset, `${at}/offset`, 0, nonWire)) return null;
      if (!isWireInteger(e.length, `${at}/length`, 0, nonWire)) return null;
      if (e.offset < end) return null;
      end = e.offset + e.length;
      if (e.op === "delta") {
        if (typeof e.from !== "string" || !SHA256_RE.test(e.from)) return null;
      } else if (e.op === "blob") {
        if (e.codec === "none") {
          if (e.length !== e.size) return null;
        } else if (e.codec !== "zstd") return null;
      } else return null;
    }
    if (end > data.bytes) return null;
    return doc as unknown as PatchDoc;
  } catch {
    return null;
  }
}
