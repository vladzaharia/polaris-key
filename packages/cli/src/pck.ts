/**
 * The Godot PCK directory, as `pkey release publish --deliverable <packId>` reads and rewrites it
 * (P4-03; notes/A6 §2.2, notes/S-05 §4.6, Godot 4.7.2 `core/io/file_access_pack.cpp`).
 *
 * Layout (little-endian):
 *
 *   magic "GDPC", format version, engine major, minor, patch, pack flags   (6 × u32, 24 bytes)
 *   v2:      file base u64, 16 reserved u32, then the directory
 *   v3, v4:  file base u64, directory offset u64, 16 reserved u32
 *   directory: u32 count, then per entry: u32 path length (NUL-padded), the path, u64 offset
 *              (relative to the file base), u64 size, 16-byte MD5, u32 entry flags
 *
 * Pack flags: 1 encrypted directory, 2 relative file base, 4 sparse bundle (the file data lives
 * elsewhere). Entry flags: 1 encrypted, 2 removal, 4 delta (a patch pack's entries, which need a
 * base pack). A data pack published through Polaris Key is none of those: `checkPckHeader`
 * refuses an encrypted directory and a sparse bundle, `readPck` refuses an encrypted, removal or
 * delta entry, each with its path, before anything is hashed.
 *
 * `rewritePck` is the strip step's writer (prototype `platform-mechanics/tools/strip_pack.py`):
 * it keeps the source header's format version, engine version and pack flags, copies every kept
 * entry's bytes and MD5, aligns file data to 16 bytes, and re-reads its own output to prove the
 * header and every kept entry's path, size, MD5, flags and bytes match the source.
 */

import { createHash } from "node:crypto";
import { checkPaths } from "@polaris-key/client-core/packs";

export const PCK_MAGIC = 0x43504447; // "GDPC"
export const PACK_DIR_ENCRYPTED = 1;
export const PACK_REL_FILEBASE = 2;
export const PACK_SPARSE_BUNDLE = 4;
export const PACK_FILE_ENCRYPTED = 1;
export const PACK_FILE_REMOVAL = 2;
export const PACK_FILE_DELTA = 4;

/** The two entries `--export-pack` always adds, which the strip step removes (S-05 §4.6). */
export const PCK_STRIP_PATHS = [
  "project.binary",
  ".godot/global_script_class_cache.cfg",
] as const;

export interface PckHeader {
  formatVersion: number;
  engine: { major: number; minor: number; patch: number };
  flags: number;
}

export interface PckEntry {
  /** The path as the directory stores it (`res://` kept when the PCK has it). */
  rawPath: string;
  /** The path the files index names: `rawPath` without a leading `res://`. */
  path: string;
  /** Absolute offset of the entry's bytes in the PCK file. */
  offset: number;
  size: number;
  md5: string;
  flags: number;
}

export interface PckDirectory {
  header: PckHeader;
  /** Entries in directory order. */
  entries: PckEntry[];
}

export class PckError extends Error {}

function view(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

function u64(dv: DataView, at: number): number {
  const v = dv.getBigUint64(at, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new PckError(`a 64-bit field at byte ${at} is out of range`);
  return Number(v);
}

/**
 * The header check, before anything else reads the PCK: a PCK v2–v4 with no encrypted directory
 * and no sparse bundle, and no pack flag this reader does not know.
 */
export function checkPckHeader(b: Uint8Array, name = "the payload"): PckHeader {
  if (b.byteLength < 24 || view(b).getUint32(0, true) !== PCK_MAGIC)
    throw new PckError(`${name} is not a Godot PCK (no GDPC magic).`);
  const dv = view(b);
  const formatVersion = dv.getUint32(4, true);
  const engine = {
    major: dv.getUint32(8, true),
    minor: dv.getUint32(12, true),
    patch: dv.getUint32(16, true),
  };
  const flags = dv.getUint32(20, true);
  if (formatVersion < 2 || formatVersion > 4)
    throw new PckError(
      `${name} is a PCK format v${formatVersion}; pkey publishes v2, v3 and v4 only.`,
    );
  if (flags & PACK_DIR_ENCRYPTED)
    throw new PckError(
      `${name} has an encrypted directory (pack flags ${flags}); a published pack is never encrypted.`,
    );
  if (flags & PACK_SPARSE_BUNDLE)
    throw new PckError(
      `${name} is a sparse bundle (pack flags ${flags}): its file data is not in this file.`,
    );
  if (flags & ~(PACK_DIR_ENCRYPTED | PACK_REL_FILEBASE | PACK_SPARSE_BUNDLE))
    throw new PckError(`${name} has unknown pack flags ${flags}.`);
  return { formatVersion, engine, flags };
}

/** Read the directory of a PCK v2–v4 (after {@link checkPckHeader}). */
export function readPck(b: Uint8Array, name = "the payload"): PckDirectory {
  const header = checkPckHeader(b, name);
  const dv = view(b);
  try {
    const fileBase = u64(dv, 24);
    let p: number;
    if (header.formatVersion === 2) p = 32 + 64;
    else p = u64(dv, 32);
    const count = dv.getUint32(p, true);
    p += 4;
    const entries: PckEntry[] = [];
    const dec = new TextDecoder("utf-8", { fatal: true });
    for (let i = 0; i < count; i++) {
      const sl = dv.getUint32(p, true);
      p += 4;
      if (p + sl > b.byteLength) throw new PckError("a path runs past the end");
      let end = p + sl;
      while (end > p && b[end - 1] === 0) end--;
      const rawPath = dec.decode(b.subarray(p, end));
      p += sl;
      const offset = fileBase + u64(dv, p);
      const size = u64(dv, p + 8);
      const md5 = Buffer.from(b.subarray(p + 16, p + 32)).toString("hex");
      const flags = dv.getUint32(p + 32, true);
      p += 36;
      const path = rawPath.startsWith("res://")
        ? rawPath.slice("res://".length)
        : rawPath;
      if (flags & PACK_FILE_ENCRYPTED)
        throw new PckError(
          `${path}: an encrypted entry; a published pack is never encrypted.`,
        );
      if (flags & (PACK_FILE_REMOVAL | PACK_FILE_DELTA))
        throw new PckError(
          `${path}: a patch pack's ${flags & PACK_FILE_REMOVAL ? "removal" : "delta"} entry (flags ${flags}); a published pack stands alone.`,
        );
      if (flags !== 0)
        throw new PckError(`${path}: unknown entry flags ${flags}.`);
      if (!pckPathOk(path))
        throw new PckError(
          `${path}: an unsafe path (a \`..\`, \`.\` or empty segment, or a character the path rules refuse).`,
        );
      if (offset + size > b.byteLength)
        throw new PckError(`${path}: its bytes run past the end of the file.`);
      entries.push({ rawPath, path, offset, size, md5, flags });
    }
    // Two entries that name one file (exactly, by ASCII case, or a file and a directory of the
    // same name) cannot both be what the admission list judged.
    const all = checkPaths(entries.map((e) => e.path));
    if (!all.ok)
      throw new PckError(
        `${all.path}: a path the directory names twice (${all.error}).`,
      );
    return { header, entries };
  } catch (e) {
    if (e instanceof PckError)
      throw new PckError(`${name}: ${e.message}`, { cause: e });
    throw new PckError(
      `${name}: the PCK directory does not parse (${(e as Error).message}).`,
    );
  }
}

/**
 * Whether a pack path (without `res://`) is one Godot will not rewrite on mount (P4-08 review
 * B1): the files index's path rules (no `..`, `.` or empty segment, no leading or trailing `/`,
 * printable ASCII without `\ : * ? " < > |`, client-core `checkPaths`), and no `..`, `./`, `//`,
 * trailing `/` or `/.` anywhere. A path that fails could land outside the prefix it appears to
 * sit under once the engine normalises it. The Godot SDK's `PKeyPck.path_ok` is the same rule.
 */
export function pckPathOk(path: string): boolean {
  if (!checkPaths([path]).ok) return false;
  return !(
    path.includes("..") ||
    path.includes("./") ||
    path.includes("//") ||
    path.endsWith("/") ||
    path.endsWith("/.")
  );
}

function pad(n: number, align: number): number {
  const r = n % align;
  return r === 0 ? 0 : align - r;
}

/**
 * Write `keep` (entries of `src`, in directory order) as a new PCK with `header`'s format
 * version, engine version and pack flags. File data follows the source's data order, 16-byte
 * aligned; offsets are relative to the file base (what every v2–v4 reader adds the base to).
 */
export function writePck(
  src: Uint8Array,
  header: PckHeader,
  keep: readonly PckEntry[],
): Uint8Array {
  const enc = new TextEncoder();
  const paths = keep.map((e) => {
    const raw = enc.encode(e.rawPath);
    const padded = new Uint8Array(raw.byteLength + pad(raw.byteLength, 4));
    padded.set(raw);
    return padded;
  });
  const dirBytes = 4 + paths.reduce((a, p) => a + 4 + p.byteLength + 36, 0);
  const headBytes = header.formatVersion === 2 ? 32 + 64 : 40 + 64;
  const dataOrder = [...keep.keys()].sort(
    (a, c) => keep[a]!.offset - keep[c]!.offset || a - c,
  );
  // v2: the directory follows the header; v3/v4: the data follows it, the directory last.
  let pos = header.formatVersion === 2 ? headBytes + dirBytes : headBytes;
  pos += pad(pos, 16);
  const fileBase = pos;
  const rel = new Array<number>(keep.length);
  for (const i of dataOrder) {
    rel[i] = pos - fileBase;
    pos += keep[i]!.size;
    pos += pad(pos, 16);
  }
  const dirOffset = header.formatVersion === 2 ? headBytes : pos;
  const total = header.formatVersion === 2 ? pos : pos + dirBytes;
  const out = new Uint8Array(total);
  const dv = view(out);
  dv.setUint32(0, PCK_MAGIC, true);
  dv.setUint32(4, header.formatVersion, true);
  dv.setUint32(8, header.engine.major, true);
  dv.setUint32(12, header.engine.minor, true);
  dv.setUint32(16, header.engine.patch, true);
  dv.setUint32(20, header.flags, true);
  dv.setBigUint64(24, BigInt(fileBase), true);
  if (header.formatVersion !== 2) dv.setBigUint64(32, BigInt(dirOffset), true);
  for (const [i, e] of keep.entries())
    out.set(src.subarray(e.offset, e.offset + e.size), fileBase + rel[i]!);
  let p = dirOffset;
  dv.setUint32(p, keep.length, true);
  p += 4;
  for (const [i, e] of keep.entries()) {
    const path = paths[i]!;
    dv.setUint32(p, path.byteLength, true);
    p += 4;
    out.set(path, p);
    p += path.byteLength;
    dv.setBigUint64(p, BigInt(rel[i]!), true);
    dv.setBigUint64(p + 8, BigInt(e.size), true);
    out.set(Buffer.from(e.md5, "hex"), p + 16);
    dv.setUint32(p + 32, e.flags, true);
    p += 36;
  }
  return out;
}

function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

export interface StripResult {
  /** The stripped PCK (the source itself when nothing was removed). */
  bytes: Uint8Array;
  /** The index paths removed, in directory order. */
  removed: string[];
  directory: PckDirectory;
}

/**
 * The strip step (S-05 §4.6): remove exactly `project.binary` and
 * `.godot/global_script_class_cache.cfg` when present, rewrite the PCK with the source header,
 * and re-read the output to prove the header and every kept entry match. Removes nothing else.
 */
export function stripPck(src: Uint8Array, name = "the payload"): StripResult {
  const dir = readPck(src, name);
  const drop = new Set<string>(PCK_STRIP_PATHS);
  const keep = dir.entries.filter((e) => !drop.has(e.path));
  const removed = dir.entries
    .filter((e) => drop.has(e.path))
    .map((e) => e.path);
  if (removed.length === 0) return { bytes: src, removed, directory: dir };
  const bytes = writePck(src, dir.header, keep);
  const again = readPck(bytes, `${name} (rewritten)`);
  const head = (h: PckHeader) =>
    `${h.formatVersion}/${h.engine.major}.${h.engine.minor}.${h.engine.patch}/${h.flags}`;
  const ok =
    head(again.header) === head(dir.header) &&
    again.entries.length === keep.length &&
    again.entries.every((e, i) => {
      const k = keep[i]!;
      return (
        e.rawPath === k.rawPath &&
        e.size === k.size &&
        e.md5 === k.md5 &&
        e.flags === k.flags &&
        sha256(bytes.subarray(e.offset, e.offset + e.size)) ===
          sha256(src.subarray(k.offset, k.offset + k.size))
      );
    });
  if (!ok)
    throw new PckError(
      `${name}: the rewritten PCK does not match the source's header and kept entries; nothing was written.`,
    );
  return { bytes, removed, directory: again };
}
