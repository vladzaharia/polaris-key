// `sync-vectors.json` `exportCases` (WIRE-CONTRACT-V5 §13.12), shared by the Node runner
// (`syncVectors.test.ts`) and the browser runner (`../browser/syncVectors.browser.test.ts`).
// Each row is replayed through `exportToSink` in `@polaris-key/client-core/sync`: the changes as
// served, a file source built from the row's recipes, a sink that collects the zip. The archive
// is then read back with a small independent zip reader (central directory, STORED entries,
// CRC-32 checked bit by bit) and its entries compared with the row: names in order, sizes,
// SHA-256, the text of the small ones, or the refusal. Nothing here imports a Node builtin.

import { describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import {
  Sha256,
  deriveCollKey,
  deriveKid,
  e2eFileCodec,
  encodeManifest,
  exportToSink,
  sealFile,
  serverFileCodec,
  webCryptoSyncPort as port,
  type ExportFilePointer,
  type ExportFileSource,
  type FileCodec,
} from "@polaris-key/client-core/sync";

export interface ExportStored {
  label: string;
  length: number;
  saltHex?: string;
  swap?: { label: string; saltHex?: string };
  extra?: number;
  cut?: number;
  flipAt?: number;
}
export interface ExportChunked {
  label: string;
  chunkLens: number[];
  saltHex?: string;
  manifestPlainSize?: number;
  plainSha256Flip?: boolean;
  manifestFlipAt?: number;
  dropChunk?: number;
  flipChunk?: number;
}
export interface ExportFileRow {
  collection: string;
  record: string;
  version: number;
  size: unknown;
  sha256: string;
  format: string;
  stored?: ExportStored;
  chunked?: ExportChunked;
}
export interface ExportCase {
  id: string;
  description: string;
  product: string;
  exportedAt: number;
  encryption: "e2e" | "server";
  rootHex?: string;
  includeRevisions: boolean;
  unsynced: number;
  caps?: { maxEntries?: number; maxBytes?: number };
  changes: unknown[];
  files: ExportFileRow[];
  expect:
    | {
        entries: Array<{
          name: string;
          size: number;
          sha256Hex: string;
          utf8?: string;
          hex?: string;
        }>;
      }
    | { refusal: { code: string } };
}

const enc = new TextEncoder();
const unhex = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
};
const hex = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
};
const sha256Hex = (b: Uint8Array): string =>
  hex(new Sha256().update(b).digest());
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0));
  let at = 0;
  for (const x of p) {
    out.set(x, at);
    at += x.length;
  }
  return out;
};

/** The deterministic plaintext of the corpus: SHA-256(label ‖ u32be(i)) blocks, cut to `length`. */
function stream(label: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  const l = enc.encode(label);
  for (let at = 0, i = 0; at < length; i++, at += 32) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, i);
    const block = new Sha256().update(l).update(ctr).digest();
    out.set(block.subarray(0, Math.min(32, length - at)), at);
  }
  return out;
}

/** What the transport serves for each file and chunk of a row. */
async function transportOf(
  row: ExportCase,
  codecs: (collection: string) => FileCodec,
): Promise<{
  whole: Map<string, Uint8Array>;
  chunks: Map<string, Uint8Array>;
}> {
  const root = row.rootHex === undefined ? null : unhex(row.rootHex);
  const whole = new Map<string, Uint8Array>();
  const chunks = new Map<string, Uint8Array>();
  const key = (f: ExportFileRow): string =>
    `${f.collection}\u0000${f.record}\u0000${f.version}`;
  for (const f of row.files) {
    if (f.stored !== undefined) {
      const r = f.stored;
      const seal = async (
        label: string,
        saltHex: string | undefined,
      ): Promise<Uint8Array> => {
        const plain = stream(label, r.length);
        if (saltHex === undefined || root === null) return plain;
        return sealFile(
          port,
          await deriveCollKey(port, root, f.collection),
          await deriveKid(port, root),
          plain,
          unhex(saltHex),
        );
      };
      let served = await seal(
        r.swap?.label ?? r.label,
        r.swap === undefined ? r.saltHex : r.swap.saltHex,
      );
      if (r.extra !== undefined)
        served = cat(served, stream(`${r.label} extra`, r.extra));
      if (r.flipAt !== undefined) {
        served = Uint8Array.from(served);
        served[r.flipAt] = served[r.flipAt]! ^ 1;
      }
      if (r.cut !== undefined) served = served.subarray(0, r.cut);
      whole.set(key(f), served);
    } else if (f.chunked !== undefined) {
      const r = f.chunked;
      const codec = codecs(f.collection);
      const total = r.chunkLens.reduce((a, b) => a + b, 0);
      const plain = stream(r.label, total);
      const records: { id: Uint8Array; plainLen: number }[] = [];
      let at = 0;
      for (const [i, len] of r.chunkLens.entries()) {
        const body = plain.subarray(at, at + len);
        at += len;
        const id = await codec.chunkId(body);
        records.push({ id, plainLen: len });
        if (r.dropChunk === i) continue;
        let obj = await codec.sealChunk(id, body);
        if (r.flipChunk === i) {
          obj = Uint8Array.from(obj);
          obj[obj.length - 1] = obj[obj.length - 1]! ^ 1;
        }
        chunks.set(`${f.collection}\u0000${hex(id)}`, obj);
      }
      const plainSha256 = new Sha256().update(plain).digest();
      if (r.plainSha256Flip === true) plainSha256[0] = plainSha256[0]! ^ 1;
      const manifest = encodeManifest({
        plainSize: r.manifestPlainSize ?? total,
        plainSha256,
        records,
      });
      let stored = manifest;
      if (root !== null)
        stored = await sealFile(
          port,
          await deriveCollKey(port, root, f.collection),
          await deriveKid(port, root),
          manifest,
          unhex(r.saltHex as string),
        );
      if (r.manifestFlipAt !== undefined) {
        stored = Uint8Array.from(stored);
        stored[r.manifestFlipAt] = stored[r.manifestFlipAt]! ^ 1;
      }
      whole.set(key(f), stored);
    }
  }
  return { whole, chunks };
}

/** A source over a row's transport: the bytes arrive in awkward pieces, and the reads are counted. */
function sourceOf(
  row: ExportCase,
  t: { whole: Map<string, Uint8Array>; chunks: Map<string, Uint8Array> },
  piece: number,
  reads: { bytes: number },
): ExportFileSource {
  return {
    async pointers(collection, record): Promise<ExportFilePointer[]> {
      return row.files
        .filter((f) => f.collection === collection && f.record === record)
        .map((f) => ({
          version: f.version,
          size: f.size,
          sha256: f.sha256,
          format: f.format,
        }));
    },
    stored(ref) {
      const bytes = t.whole.get(
        `${ref.collection}\u0000${ref.record}\u0000${ref.version}`,
      );
      return (async function* () {
        if (bytes === undefined) return;
        for (let at = 0; at < bytes.length; at += piece) {
          const p = bytes.subarray(at, at + piece);
          reads.bytes += p.length;
          yield p;
        }
      })();
    },
    async chunk(collection, idHex) {
      return t.chunks.get(`${collection}\u0000${idHex}`) ?? null;
    },
  };
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** A STORED zip32 read through its central directory, every CRC-32 recomputed. */
export function readStoredZip(zip: Uint8Array): ZipEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.length);
  const end = zip.length - 22;
  if (v.getUint32(end, true) !== 0x06054b50) throw new Error("no end record");
  const n = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const crcOf = (b: Uint8Array): number => {
    let c = 0xffff_ffff;
    for (let i = 0; i < b.length; i++) {
      c ^= b[i]!;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffff_ffff) >>> 0;
  };
  const out: ZipEntry[] = [];
  for (let i = 0; i < n; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error("bad central");
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const skip = v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLen),
    );
    if (method !== 0) throw new Error("not stored");
    if (v.getUint32(local, true) !== 0x04034b50) throw new Error("bad local");
    const start =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    if (crcOf(data) !== crc) throw new Error(`crc mismatch: ${name}`);
    const d = start + size;
    if (
      v.getUint32(d, true) !== 0x08074b50 ||
      v.getUint32(d + 4, true) !== crc ||
      v.getUint32(d + 8, true) !== size ||
      v.getUint32(d + 12, true) !== size
    )
      throw new Error(`bad descriptor: ${name}`);
    out.push({ name, data });
    at += 46 + nameLen + skip;
  }
  return out;
}

export interface ExportRun {
  zip: Uint8Array;
  writes: number;
  maxPiece: number;
  stored: number;
}

/** Runs one row to a collecting sink. Rejections are returned, not thrown. */
export async function runExportCase(
  row: ExportCase,
  piece = 300_007,
): Promise<{ run: ExportRun; error?: unknown }> {
  const root = row.rootHex === undefined ? null : unhex(row.rootHex);
  const codecs = (collection: string): FileCodec =>
    root === null
      ? serverFileCodec(port)
      : e2eFileCodec(port, root, collection);
  const t = await transportOf(row, codecs);
  const reads = { bytes: 0 };
  const parts: Uint8Array[] = [];
  let maxPiece = 0;
  const run = (): ExportRun => ({
    zip: cat(...parts),
    writes: parts.length,
    maxPiece,
    stored: reads.bytes,
  });
  try {
    await exportToSink(
      {
        product: row.product,
        exportedAt: row.exportedAt,
        unsynced: row.unsynced,
        includeRevisions: row.includeRevisions,
        ...(row.caps === undefined ? {} : { caps: row.caps }),
        changes: row.changes,
        port,
        root,
        files: sourceOf(row, t, piece, reads),
      },
      {
        write(chunk) {
          // A host may hold what it is handed: keep a copy.
          parts.push(Uint8Array.from(chunk));
          maxPiece = Math.max(maxPiece, chunk.length);
        },
      },
    );
  } catch (error) {
    return { run: run(), error };
  }
  return { run: run() };
}

export function defineExportSuites(rows: ExportCase[]): void {
  describe("sync-vectors.json: exportCases", () => {
    it("has rows", () => {
      expect(rows.length).toBeGreaterThan(0);
    });
    for (const row of rows) {
      it(`${row.id}: ${"refusal" in row.expect ? "refused before the first byte" : "the archive's entries"}`, async () => {
        const { run, error } = await runExportCase(row);
        if ("refusal" in row.expect) {
          expect(error).toBeInstanceOf(PolarisError);
          expect((error as PolarisError).code).toBe(row.expect.refusal.code);
          expect(run.writes).toBe(0);
          // Only manifests may have been fetched to plan: never a file or a chunk.
          expect(run.stored).toBeLessThan(4096);
          return;
        }
        if (error !== undefined) throw error;
        const got = readStoredZip(run.zip);
        const want = row.expect.entries;
        expect(got.map((e) => e.name)).toEqual(want.map((e) => e.name));
        for (const [i, w] of want.entries()) {
          const g = got[i]!;
          expect(g.data.length, `${w.name} size`).toBe(w.size);
          expect(sha256Hex(g.data), `${w.name} sha256`).toBe(w.sha256Hex);
          if (w.utf8 !== undefined)
            expect(new TextDecoder().decode(g.data), w.name).toBe(w.utf8);
          if (w.hex !== undefined) expect(hex(g.data), w.name).toBe(w.hex);
        }
        // A sink is handed pieces no larger than a segment plus its tag.
        expect(run.maxPiece).toBeLessThanOrEqual(1_048_576 + 16);
      });
    }
  });
}
