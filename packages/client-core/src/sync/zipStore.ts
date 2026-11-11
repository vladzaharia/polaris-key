// A streaming STORED zip32 writer (WIRE-CONTRACT-V5 §13.12, "Container" and "Bounds"). Every entry
// is written as it arrives, with a data descriptor after its data (the sizes and CRC-32 are known
// only then), so memory is one piece of the caller's data and the central directory's records
// (46 bytes plus a name each). No compression, no extra field, no comment, no zip64: the overhead
// of an entry is `SYNC_EXPORT_ZIP_ENTRY_BYTES` (30 + 16 + 46) plus its name twice, and the archive
// ends with `SYNC_EXPORT_ZIP_END_BYTES` (22), which is what the export plan counts.
//
// The central directory is written in the order the caller names, which may differ from the order
// the entries were written in: a reader (`unzip`, `zipfile`) lists the central directory. The
// export uses that to write each file before the record line that cites its size and hash.
//
// A write that would take the archive past zip32 (4 GiB - 1 for the data, the descriptors, the
// central directory and the end record together, or 65,535 entries) refuses with
// `sync-export-too-large` before it reaches the sink: the writer never produces a wrong archive.

import {
  SYNC_EXPORT_ZIP_ENTRY_BYTES,
  SYNC_EXPORT_ZIP_END_BYTES,
} from "@polaris-key/protocol/sync";
import { PolarisError } from "../errors.js";

/** Where the archive goes. A host implements it for its platform (a file, a Blob, a stream); the
 *  writer calls it in order and awaits each call, so a sink that applies back pressure just
 *  returns a promise. Committing (a rename, closing a stream) and discarding on failure belong to
 *  the host, after the export's promise settles. */
export interface ZipSink {
  write(chunk: Uint8Array): void | Promise<void>;
}

const MAX_U32 = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
/** The fixed DOS time and date (1980-01-01 00:00:00): an archive never says when it was made. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
const FLAGS = 0x0808;
const VERSION = 20;

/** The 256 remainders of the reflected polynomial 0xEDB88320, one per byte value. */
const TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let r = byte;
  for (let bit = 0; bit < 8; bit++) r = (r >>> 1) ^ (0xedb88320 & -(r & 1));
  return r >>> 0;
});

/** An incremental CRC-32 (IEEE 802.3, the zip checksum). */
export class Crc32 {
  private c = 0xffff_ffff;
  update(data: Uint8Array): this {
    let state = this.c;
    for (const byte of data)
      state = (state >>> 8) ^ TABLE[(state ^ byte) & 0xff]!;
    this.c = state;
    return this;
  }
  digest(): number {
    return (this.c ^ 0xffff_ffff) >>> 0;
  }
}

const tooLarge = (): PolarisError =>
  new PolarisError(
    "sync-export-too-large",
    "The export is too large for a zip file",
  );

interface Done {
  name: string;
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

interface Open {
  name: string;
  nameBytes: Uint8Array;
  offset: number;
  crc: Crc32;
  size: number;
}

const utf8 = new TextEncoder();

export class ZipStoreWriter {
  private offset = 0;
  private readonly done: Done[] = [];
  private cur: Open | null = null;
  private finished = false;
  /** Bytes the archive still needs after the data written so far: the central records of the
   *  entries done, the open entry's descriptor and central record, and the end record. */
  private reserve = SYNC_EXPORT_ZIP_END_BYTES;

  /** `limit` is zip32's 4 GiB - 1; a test lowers it to meet the refusal without writing 4 GiB. */
  constructor(
    private readonly sink: ZipSink,
    private readonly limit: number = MAX_U32,
  ) {}

  /** Bytes sent to the sink so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  get entries(): number {
    return this.done.length + (this.cur === null ? 0 : 1);
  }

  private async emit(b: Uint8Array): Promise<void> {
    this.offset += b.length;
    await this.sink.write(b);
  }

  /** Starts an entry. The name is UTF-8 and not empty. */
  async begin(name: string): Promise<void> {
    if (this.finished || this.cur !== null)
      throw new Error("zip: an entry is open or the archive is finished");
    const nameBytes = utf8.encode(name);
    if (nameBytes.length === 0 || nameBytes.length > 0xffff)
      throw new RangeError("zip: entry name length");
    if (this.done.some((d) => d.name === name))
      throw new RangeError("zip: entry name repeats");
    if (this.done.length + 1 > MAX_ENTRIES) throw tooLarge();
    // This entry's header, descriptor and central record, before any byte of it is written.
    const need =
      30 +
      nameBytes.length +
      (SYNC_EXPORT_ZIP_ENTRY_BYTES - 30) +
      nameBytes.length;
    if (this.offset + need + this.reserve > this.limit) throw tooLarge();
    const h = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, VERSION, true);
    v.setUint16(6, FLAGS, true);
    v.setUint16(8, 0, true); // STORED
    v.setUint16(10, DOS_TIME, true);
    v.setUint16(12, DOS_DATE, true);
    // crc, compressed and uncompressed sizes: zero, the descriptor holds them
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);
    h.set(nameBytes, 30);
    const at = this.offset;
    this.reserve += 16 + 46 + nameBytes.length;
    this.cur = { name, nameBytes, offset: at, crc: new Crc32(), size: 0 };
    await this.emit(h);
  }

  /** Appends data to the open entry. */
  async write(data: Uint8Array): Promise<void> {
    const c = this.cur;
    if (c === null) throw new Error("zip: no entry is open");
    if (data.length === 0) return;
    if (this.offset + data.length + this.reserve > this.limit) throw tooLarge();
    c.crc.update(data);
    c.size += data.length;
    await this.emit(data);
  }

  /** Ends the open entry with its data descriptor. */
  async end(): Promise<{ size: number; crc32: number }> {
    const c = this.cur;
    if (c === null) throw new Error("zip: no entry is open");
    const crc = c.crc.digest();
    const d = new Uint8Array(16);
    const v = new DataView(d.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, crc, true);
    v.setUint32(8, c.size, true);
    v.setUint32(12, c.size, true);
    // The descriptor's 16 bytes were reserved at `begin`.
    this.reserve -= 16;
    this.cur = null;
    this.done.push({
      name: c.name,
      nameBytes: c.nameBytes,
      crc,
      size: c.size,
      offset: c.offset,
    });
    await this.emit(d);
    return { size: c.size, crc32: crc };
  }

  /** A whole entry from one buffer. */
  async addBytes(name: string, data: Uint8Array): Promise<void> {
    await this.begin(name);
    await this.write(data);
    await this.end();
  }

  /**
   * Writes the central directory and the end record. `order` names every entry once, in the order
   * a reader will list them; omitted, the order they were written in.
   */
  async finish(order?: readonly string[]): Promise<{ bytes: number }> {
    if (this.finished || this.cur !== null)
      throw new Error("zip: an entry is open or the archive is finished");
    const byName = new Map(this.done.map((d) => [d.name, d]));
    const list =
      order === undefined ? this.done : order.map((n) => byName.get(n));
    if (
      list.length !== this.done.length ||
      list.some((d) => d === undefined) ||
      new Set(list).size !== list.length
    )
      throw new RangeError("zip: the order does not name every entry once");
    this.finished = true;
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const d of list as Done[]) {
      const r = new Uint8Array(46 + d.nameBytes.length);
      const v = new DataView(r.buffer);
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, VERSION, true);
      v.setUint16(6, VERSION, true);
      v.setUint16(8, FLAGS, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, DOS_TIME, true);
      v.setUint16(14, DOS_DATE, true);
      v.setUint32(16, d.crc, true);
      v.setUint32(20, d.size, true);
      v.setUint32(24, d.size, true);
      v.setUint16(28, d.nameBytes.length, true);
      // extra, comment, disk, internal and external attributes: zero
      v.setUint32(42, d.offset, true);
      r.set(d.nameBytes, 46);
      cdSize += r.length;
      await this.emit(r);
    }
    const e = new Uint8Array(SYNC_EXPORT_ZIP_END_BYTES);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, list.length, true);
    v.setUint16(10, list.length, true);
    v.setUint32(12, cdSize, true);
    v.setUint32(16, cdOffset, true);
    await this.emit(e);
    return { bytes: this.offset };
  }
}
