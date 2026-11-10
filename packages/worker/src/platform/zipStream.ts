/**
 * A streamed zip writer (U-12.3): STORED entries, each followed by a data descriptor, the CRC-32
 * computed as the bytes pass, and a central directory at the end. Zip32 only (the portal's data
 * export is far below 4 GiB, and anything that is not is refused rather than written wrong).
 *
 * Memory is one chunk at a time: an entry's source is an iterable of byte chunks, and nothing
 * here holds more than the chunk in hand plus a small record per entry for the central directory.
 *
 * Names are the only input that can hurt a reader: an unzip that trusts a name writes outside its
 * folder. {@link checkEntryName} refuses every name that is absolute, has an empty, `.` or `..`
 * segment, a backslash, a drive colon or a control character, or that repeats an earlier one.
 */

/** One entry's bytes: a buffer, or a lazy source of chunks read only when the entry is written. */
export type ZipBytes = Uint8Array | AsyncIterable<Uint8Array>;

/** An entry to write. `read` is called once, when the entry's turn comes. */
export interface ZipEntry {
  /** A relative, slash-separated name (see {@link checkEntryName}). */
  name: string;
  read(): ZipBytes | Promise<ZipBytes>;
}

/** The zip format's own limits for the variant written here. */
export const ZIP_MAX_ENTRIES = 65_000;
export const ZIP_MAX_BYTES = 0xffff_ffff;
const MAX_NAME_BYTES = 255;

export class ZipError extends Error {
  constructor(
    readonly reason: "name" | "entries" | "size",
    message: string,
  ) {
    super(message);
    this.name = "ZipError";
  }
}

/** The byte-at-a-time CRC-32 table (reflected polynomial 0xedb88320). */
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});

/** CRC-32 (IEEE) of `bytes`, continuing from `crc` (the value returned by a previous call). */
export function crc32(bytes: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return ~c >>> 0;
}

/** Throws a {@link ZipError} unless `name` is safe to put in an archive. */
export function checkEntryName(name: string): void {
  const bad = (why: string): never => {
    throw new ZipError("name", `entry name refused (${why})`);
  };
  if (name.length === 0) bad("empty");
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) bad("too long");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:]/.test(name)) bad("forbidden character");
  if (name.startsWith("/")) bad("absolute");
  for (const seg of name.split("/")) {
    if (seg === "" || seg === "." || seg === "..") bad("path segment");
  }
}

/** Check every name up front: valid, and none repeated. Throws a {@link ZipError}. */
export function checkEntries(entries: readonly { name: string }[]): void {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new ZipError("entries", `more than ${ZIP_MAX_ENTRIES} entries`);
  }
  const seen = new Set<string>();
  for (const { name } of entries) {
    checkEntryName(name);
    if (seen.has(name)) {
      throw new ZipError("name", "entry name refused (repeated)");
    }
    seen.add(name);
  }
}

// DOS time/date for 1980-01-01 00:00:00, the fixed stamp: an export's own time is in data.json.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 3 (sizes and CRC follow in a descriptor) and bit 11 (UTF-8 names). */
const FLAGS = 0x0008 | 0x0800;

interface Done {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
}

function u16(v: DataView, o: number, n: number): void {
  v.setUint16(o, n, true);
}
function u32(v: DataView, o: number, n: number): void {
  v.setUint32(o, n >>> 0, true);
}

function localHeader(nameBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(out.buffer);
  u32(v, 0, 0x04034b50);
  u16(v, 4, 20);
  u16(v, 6, FLAGS);
  u16(v, 8, 0); // STORED
  u16(v, 10, DOS_TIME);
  u16(v, 12, DOS_DATE);
  // crc and both sizes are 0 here; the data descriptor carries them.
  u16(v, 26, nameBytes.length);
  out.set(nameBytes, 30);
  return out;
}

function descriptor(crc: number, size: number): Uint8Array {
  const out = new Uint8Array(16);
  const v = new DataView(out.buffer);
  u32(v, 0, 0x08074b50);
  u32(v, 4, crc);
  u32(v, 8, size);
  u32(v, 12, size);
  return out;
}

function centralDirectory(done: readonly Done[], start: number): Uint8Array {
  let len = 22;
  for (const d of done) len += 46 + d.nameBytes.length;
  const out = new Uint8Array(len);
  const v = new DataView(out.buffer);
  let o = 0;
  for (const d of done) {
    u32(v, o, 0x02014b50);
    u16(v, o + 4, 20);
    u16(v, o + 6, 20);
    u16(v, o + 8, FLAGS);
    u16(v, o + 10, 0);
    u16(v, o + 12, DOS_TIME);
    u16(v, o + 14, DOS_DATE);
    u32(v, o + 16, d.crc);
    u32(v, o + 20, d.size);
    u32(v, o + 24, d.size);
    u16(v, o + 28, d.nameBytes.length);
    u32(v, o + 42, d.offset);
    out.set(d.nameBytes, o + 46);
    o += 46 + d.nameBytes.length;
  }
  u32(v, o, 0x06054b50);
  u16(v, o + 8, done.length);
  u16(v, o + 10, done.length);
  u32(v, o + 12, o);
  u32(v, o + 16, start);
  return out;
}

async function* chunksOf(bytes: ZipBytes): AsyncGenerator<Uint8Array> {
  if (bytes instanceof Uint8Array) yield bytes;
  else yield* bytes;
}

/**
 * The archive as a byte stream. Names and the entry count are checked before the first byte is
 * produced (so a caller can answer a refusal as an ordinary response); an entry whose source
 * fails, or a total past zip32, errors the stream so a truncated file is never taken for whole.
 */
export function zipStream(
  entries: readonly ZipEntry[],
): ReadableStream<Uint8Array> {
  checkEntries(entries);
  const encoder = new TextEncoder();
  const gen = (async function* (): AsyncGenerator<Uint8Array> {
    const done: Done[] = [];
    let pos = 0;
    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const offset = pos;
      const head = localHeader(nameBytes);
      pos += head.length;
      yield head;
      let crc = 0;
      let size = 0;
      for await (const chunk of chunksOf(await entry.read())) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        pos += chunk.length;
        if (pos > ZIP_MAX_BYTES) {
          throw new ZipError("size", "archive past 4 GiB");
        }
        yield chunk;
      }
      const tail = descriptor(crc, size);
      pos += tail.length;
      yield tail;
      done.push({ nameBytes, crc, size, offset });
    }
    if (pos > ZIP_MAX_BYTES) throw new ZipError("size", "archive past 4 GiB");
    yield centralDirectory(done, pos);
  })();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await gen.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}
