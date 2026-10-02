/**
 * A small ZIP reader and a STORE-only writer (P2b-05), enough for what the CLI must do with an
 * archive and no more: read an IPA's `Info.plist` and executables, an APK's binary manifest, its
 * `lib/` entries and the bytes before its central directory (the APK Signing Block), and write
 * the one-file `entry.jar` that `apksigner` then signs.
 *
 * The reader opens the file and reads only what it is asked for: the end-of-central-directory
 * record (ZIP64 included, since a game's export can pass 4 GiB), the central directory, and an
 * entry's own local header and data on demand, inflated with `node:zlib` (STORE and DEFLATE —
 * the two methods IPAs, APKs and jars use). An encrypted entry, or one compressed any other way,
 * is refused. The writer emits STORE entries with a fixed timestamp, so the same input always
 * produces the same bytes.
 */

import { open, type FileHandle } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
/** The largest entry the reader inflates into memory (a game's executable can be large). */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ZipError("a ZIP64 field is out of range");
  return Number(v);
}

export class ZipReader {
  private constructor(
    private readonly fh: FileHandle,
    readonly path: string,
    readonly fileSize: number,
    readonly entries: readonly ZipEntry[],
    /** Where the central directory starts: the APK Signing Block ends right before it. */
    readonly centralDirectoryOffset: number,
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const fh = await open(path, "r");
    try {
      const { size } = await fh.stat();
      const tailLen = Math.min(size, 65_557);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === EOCD_SIG) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new ZipError(`${path} is not a ZIP archive`);
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      if (
        count === 0xffff ||
        cdSize === 0xffffffff ||
        cdOffset === 0xffffffff
      ) {
        const loc = eocd - 20;
        if (loc < 0 || tail.readUInt32LE(loc) !== ZIP64_LOCATOR_SIG)
          throw new ZipError(`${path}: ZIP64 locator missing`);
        const recOffset = u64(tail, loc + 8);
        const rec = Buffer.alloc(56);
        await fh.read(rec, 0, 56, recOffset);
        if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG)
          throw new ZipError(`${path}: ZIP64 end record missing`);
        count = u64(rec, 32);
        cdSize = u64(rec, 40);
        cdOffset = u64(rec, 48);
      }
      if (cdOffset + cdSize > size)
        throw new ZipError(`${path}: the central directory runs past the end`);
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG)
          throw new ZipError(`${path}: a central directory entry is malformed`);
        const flags = cd.readUInt16LE(p + 8);
        const method = cd.readUInt16LE(p + 10);
        const crc32 = cd.readUInt32LE(p + 16);
        let compressedSize = cd.readUInt32LE(p + 20);
        let uncompressed = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        let localOffset = cd.readUInt32LE(p + 42);
        const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
        // ZIP64 extended information: the fields that overflowed, in this order.
        let x = p + 46 + nameLen;
        const xEnd = x + extraLen;
        while (x + 4 <= xEnd) {
          const id = cd.readUInt16LE(x);
          const len = cd.readUInt16LE(x + 2);
          if (id === 0x0001) {
            let q = x + 4;
            if (uncompressed === 0xffffffff) {
              uncompressed = u64(cd, q);
              q += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = u64(cd, q);
              q += 8;
            }
            if (localOffset === 0xffffffff) localOffset = u64(cd, q);
          }
          x += 4 + len;
        }
        entries.push({
          name,
          method,
          flags,
          crc32,
          compressedSize,
          size: uncompressed,
          localOffset,
        });
        p = xEnd + commentLen;
      }
      return new ZipReader(fh, path, size, entries, cdOffset);
    } catch (e) {
      await fh.close();
      throw e;
    }
  }

  entry(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Bytes `[offset, offset + length)` of the archive file itself. */
  async readRaw(offset: number, length: number): Promise<Buffer> {
    if (offset < 0 || length < 0 || offset + length > this.fileSize)
      throw new ZipError(`${this.path}: a read runs past the end`);
    const buf = Buffer.alloc(length);
    await this.fh.read(buf, 0, length, offset);
    return buf;
  }

  /** One entry's uncompressed bytes. */
  async read(entry: ZipEntry): Promise<Buffer> {
    if (entry.flags & 0x1) throw new ZipError(`${entry.name} is encrypted`);
    if (entry.size > MAX_ENTRY_BYTES || entry.compressedSize > MAX_ENTRY_BYTES)
      throw new ZipError(`${entry.name} is too large to read`);
    const lfh = await this.readRaw(entry.localOffset, 30);
    if (lfh.readUInt32LE(0) !== LFH_SIG)
      throw new ZipError(`${entry.name}: local header missing`);
    const start =
      entry.localOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
    const raw = await this.readRaw(start, entry.compressedSize);
    if (entry.method === 0) return raw;
    if (entry.method === 8)
      return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new ZipError(
      `${entry.name} uses compression method ${entry.method}, which pkey does not read`,
    );
  }

  close(): Promise<void> {
    return this.fh.close();
  }
}

/** Open, run `fn`, close — whatever `fn` does. */
export async function withZip<T>(
  path: string,
  fn: (zip: ZipReader) => Promise<T>,
): Promise<T> {
  const zip = await ZipReader.open(path);
  try {
    return await fn(zip);
  } finally {
    await zip.close();
  }
}

// ── The writer ───────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++)
    c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** 1980-01-01 00:00:00, DOS format: a fixed timestamp keeps the output deterministic. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A ZIP of STORE entries, in the order given. */
export function zipStore(
  files: ReadonlyArray<{ name: string; data: Uint8Array }>,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(LFH_SIG, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(f.data.length, 18);
    lfh.writeUInt32LE(f.data.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, name, Buffer.from(f.data));
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CDH_SIG, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(DOS_TIME, 12);
    cdh.writeUInt16LE(DOS_DATE, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(f.data.length, 20);
    cdh.writeUInt32LE(f.data.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
