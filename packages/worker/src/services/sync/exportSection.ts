/**
 * Cloud Sync's part of a person's export (U-12.4), `stores["sync.cloudSync"]` of
 * `pkey-product-export/1` and the zip's `stores/sync.cloudSync/` folder. Built from the object's
 * bounded pages (`do/exportPages.ts`), never from `exportAll`, so what one request holds in memory
 * is one page or one R2 read, whatever the person stored.
 *
 * JSON (`exportSection`): the directory counters, usage, the mode and `encryptionSince`, the
 * settings rows (the store's own caps keep them small), per-collection counters, the client
 * bindings (`clientId`, `deviceId`, `lastSeen`: no mutation counters) and, only while they are
 * small, the records (at most {@link INLINE_RECORDS_BYTES} of JSON, else `recordsIn: "zip"`) and
 * the file metadata (at most {@link INLINE_FILES_ROWS} rows, else `filesIn: "zip"`). Chunks are
 * counted; their bytes are in the zip.
 *
 * Zip (`exportEntries`, names relative to the store's folder; an entry name is an index, never an
 * id the person's data names, and the index files map them):
 *   index.json              which entry holds what
 *   records/<i>.ndjson      one collection's rows a line each: live, tombstones, in 500-row pages
 *   records/parked.ndjson   the copies earlier account merges parked
 *   files.json, files/<n>.bin   every live file and kept revision: the stored bytes (ciphertext
 *                           in end-to-end mode, plaintext opened with the person's SSE-C key
 *                           otherwise), one R2 read at a time
 *   chunks/<j>.bin, chunks.json   a collection's chunks back to back, with the offset of each
 *
 * Who may read: the caller is the portal's export, which has authenticated the account and
 * resolved the subject itself; the object answers only the pinned `(product, subject)`'s rows, and
 * an R2 key or SSE-C key is read from that object's own rows, never from a request.
 */
import type { SubjectStoreContext } from "../../core/accounts/subjectHooks.js";
import {
  ZIP_MAX_ENTRIES,
  ZipError,
  type ZipEntry,
} from "../../platform/zipStream.js";
import {
  callCloudSync,
  exportPageCloudSync,
  fileStoreOf,
} from "./do/client.js";
import type {
  DoPin,
  ExportSummary,
  ExportedFile,
  ExportedParked,
  ExportedRecord,
} from "./do/protocol.js";
import { getActiveSchema } from "../../core/products/store.js";
import { syncMode } from "./handlers/common.js";

/** Records stay inline in the JSON only while they add up to this much. */
export const INLINE_RECORDS_BYTES = 4 * 1024 * 1024;
/** File metadata stays inline in the JSON up to this many rows. */
export const INLINE_FILES_ROWS = 2000;
/** Rows read from the object per page. */
const PAGE = 500;
/**
 * What one export may ask the Worker's subrequest budget for: two calls a file (its pointer and
 * the R2 read) and one a chunk (a page row carries the source), with margin for the pages. Past
 * it the zip is refused up front (`413`), never cut off halfway. It also keeps the file and chunk
 * indexes, which are held while the zip is written, a few hundred KiB.
 */
export const MAX_EXPORT_SUBREQUESTS = 8_000;

const enc = new TextEncoder();
const size = (v: unknown): number => JSON.stringify(v).length;

type Ctx = Pick<SubjectStoreContext, "db" | "env">;

async function summaryOf(ctx: Ctx, pin: DoPin): Promise<ExportSummary | null> {
  return (await exportPageCloudSync(ctx.env, pin, { part: "summary" })).summary;
}

/** The records of every collection, then the parked copies, until `budget` bytes of JSON are spent. */
async function inlineRecords(
  ctx: Ctx,
  pin: DoPin,
  s: ExportSummary,
): Promise<{ records: ExportedRecord[]; parked: ExportedParked[] } | null> {
  let budget = INLINE_RECORDS_BYTES;
  const records: ExportedRecord[] = [];
  const parked: ExportedParked[] = [];
  for (const collection of s.recordCollections) {
    for (let after = 0, more = true; more; ) {
      const page = await exportPageCloudSync(ctx.env, pin, {
        part: "records",
        collection,
        after,
        limit: PAGE,
      });
      for (const row of page.rows) {
        budget -= size(row);
        if (budget < 0) return null;
        records.push(row);
      }
      more = page.next !== null;
      after = page.next ?? 0;
    }
  }
  for (let after = 0, more = s.parked > 0; more; ) {
    const page = await exportPageCloudSync(ctx.env, pin, {
      part: "parked",
      after,
      limit: PAGE,
    });
    for (const row of page.rows) {
      budget -= size(row);
      if (budget < 0) return null;
      parked.push(row);
    }
    more = page.next !== null;
    after = page.next ?? 0;
  }
  return { records, parked };
}

/** Every file's metadata, paged: the pointer fields only, in (collection, record, version) order. */
async function* fileRows(ctx: Ctx, pin: DoPin): AsyncGenerator<ExportedFile> {
  for (let after: [string, string, number] | undefined, more = true; more; ) {
    const page = await exportPageCloudSync(ctx.env, pin, {
      part: "files",
      ...(after ? { after } : {}),
      limit: PAGE,
    });
    yield* page.rows;
    more = page.next !== null;
    after = page.next ?? undefined;
  }
}

/** The bounded JSON section. `null` settings: the person has no object here. */
export async function exportSection(
  ctx: Ctx,
  pin: DoPin,
): Promise<Record<string, unknown> | null> {
  const s = await summaryOf(ctx, pin);
  if (!s) return null;
  const mode = await syncMode(
    ctx.env,
    ctx.db,
    pin.product,
    await getActiveSchema(ctx.db, pin.product),
  );
  const out: Record<string, unknown> = {
    encryption: mode.serve,
    ...(s.encryptionSince !== undefined
      ? { encryptionSince: s.encryptionSince }
      : {}),
    usage: s.usage,
    settings: s.settings,
    collections: s.collections,
    tombstones: s.tombstones,
    clients: s.clients,
  };
  const hasRecords = s.recordCollections.length > 0 || s.parked > 0;
  if (hasRecords) {
    // A store the counters already put over the bound is not read at all.
    const inline =
      s.usage.recordBytes > INLINE_RECORDS_BYTES
        ? null
        : await inlineRecords(ctx, pin, s);
    if (inline) {
      if (inline.records.length > 0) out.records = inline.records;
      if (inline.parked.length > 0) out.parked = inline.parked;
    } else out.recordsIn = "zip";
  }
  out.fileCount = s.files;
  if (s.files > 0) {
    if (s.files > INLINE_FILES_ROWS) out.filesIn = "zip";
    else {
      const files: ExportedFile[] = [];
      for await (const f of fileRows(ctx, pin)) files.push(f);
      out.files = files;
    }
  }
  const count = s.chunks.reduce((n, c) => n + c.count, 0);
  if (count > 0) {
    out.chunks = {
      count,
      bytes: s.chunks.reduce((n, c) => n + c.bytes, 0),
      in: "zip",
    };
  }
  return out;
}

// ── the zip ──────────────────────────────────────────────────────────────────────────────────

/** An R2 object's body as chunks; the stream is cancelled if the reader stops early. */
async function* chunksOf(body: ReadableStream): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value instanceof Uint8Array ? value : new Uint8Array(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Opens one R2 object of this person's rows; throws when it is missing or not the recorded size. */
async function openObject(
  bucket: R2Bucket | undefined,
  prefixes: readonly string[],
  key: string,
  ssecKey: string | undefined,
  bytes: number,
): Promise<ReadableStream> {
  if (!bucket)
    throw new Error("cloud sync export: the file store is not bound");
  // Only this person's objects (their own subject, or one folded into it): nothing else is read.
  if (!prefixes.some((p) => key.startsWith(p)))
    throw new Error("cloud sync export: an object outside the person's prefix");
  const obj = await bucket.get(key, {
    ...(ssecKey !== undefined ? { ssecKey } : {}),
  });
  // The row says the object is there and this long. If not, the bytes are lost or wrong, and the
  // archive stops rather than carry a file that is not the person's.
  if (!obj || !("body" in obj) || obj.size !== bytes)
    throw new Error("cloud sync export: a stored object is missing");
  return obj.body;
}

async function* ndjson(
  next: () => Promise<{ rows: unknown[]; more: boolean }>,
): AsyncGenerator<Uint8Array> {
  for (let more = true; more; ) {
    const page = await next();
    more = page.more;
    if (page.rows.length > 0)
      yield enc.encode(page.rows.map((r) => JSON.stringify(r) + "\n").join(""));
  }
}

/** Compact: the indexes are held whole, so they are not indented. */
const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

export async function exportEntries(ctx: Ctx, pin: DoPin): Promise<ZipEntry[]> {
  const s = await summaryOf(ctx, pin);
  if (!s) return [];
  const bucket = fileStoreOf(ctx.env);
  const chunkRows = s.chunks.reduce((n, c) => n + c.count, 0);
  if (
    s.files + s.recordCollections.length + s.chunks.length > ZIP_MAX_ENTRIES ||
    2 * s.files + chunkRows > MAX_EXPORT_SUBREQUESTS
  )
    throw new ZipError("entries", "the Cloud Sync data has too many entries");
  if ((s.files > 0 || chunkRows > 0) && !bucket)
    throw new Error("cloud sync export: the file store is not bound");

  const entries: ZipEntry[] = [];
  const index: Record<string, unknown> = {};

  // Records: one file a collection, then the parked copies.
  index.records = s.recordCollections.map((collection, i) => {
    const name = `records/${i}.ndjson`;
    entries.push({
      name,
      read: () => {
        let after = 0;
        return ndjson(async () => {
          const page = await exportPageCloudSync(ctx.env, pin, {
            part: "records",
            collection,
            after,
            limit: PAGE,
          });
          after = page.next ?? 0;
          return { rows: page.rows, more: page.next !== null };
        });
      },
    });
    return { collection, entry: name };
  });
  if (s.parked > 0) {
    index.parked = "records/parked.ndjson";
    entries.push({
      name: "records/parked.ndjson",
      read: () => {
        let after = 0;
        return ndjson(async () => {
          const page = await exportPageCloudSync(ctx.env, pin, {
            part: "parked",
            after,
            limit: PAGE,
          });
          after = page.next ?? 0;
          return { rows: page.rows, more: page.next !== null };
        });
      },
    });
  }

  // Files: the list first (names and the listing are known before a byte is sent), then each
  // file's bytes when its turn comes.
  if (s.files > 0) {
    const listing: Array<ExportedFile & { entry: string }> = [];
    let n = 0;
    for await (const f of fileRows(ctx, pin)) {
      const name = `files/${++n}.bin`;
      listing.push({ ...f, entry: name });
      entries.push({
        name,
        read: async () => {
          const r = await callCloudSync<"fileResolve">(ctx.env, pin, {
            op: "fileResolve",
            collection: f.collection,
            recordId: f.recordId,
            version: f.version,
          });
          if (!r.outcome.ok)
            throw new Error("cloud sync export: a file is gone");
          const file = r.outcome.file;
          return chunksOf(
            await openObject(
              bucket,
              s.keyPrefixes,
              file.key,
              file.ssecKey,
              file.size,
            ),
          );
        },
      });
    }
    index.files = "files.json";
    entries.push({ name: "files.json", read: () => json(listing) });
  }

  // Chunks: a container a collection; the index is what was written, so it follows them.
  if (chunkRows > 0) {
    const written: Array<{
      collection: string;
      entry: string;
      chunks: Array<{ chunkId: string; offset: number; size: number }>;
    }> = [];
    s.chunks.forEach((c, j) => {
      const name = `chunks/${j}.bin`;
      const mine = {
        collection: c.collection,
        entry: name,
        chunks: [] as Array<{ chunkId: string; offset: number; size: number }>,
      };
      written.push(mine);
      entries.push({
        name,
        read: () =>
          (async function* (): AsyncGenerator<Uint8Array> {
            let offset = 0;
            for (let after = "", more = true; more; ) {
              const page = await exportPageCloudSync(ctx.env, pin, {
                part: "chunks",
                collection: c.collection,
                after,
                limit: PAGE,
              });
              for (const row of page.rows) {
                const body = await openObject(
                  bucket,
                  s.keyPrefixes,
                  row.key,
                  row.ssecKey,
                  row.storedBytes,
                );
                mine.chunks.push({
                  chunkId: row.chunkId,
                  offset,
                  size: row.storedBytes,
                });
                offset += row.storedBytes;
                yield* chunksOf(body);
              }
              more = page.next !== null;
              after = page.next ?? "";
            }
          })(),
      });
    });
    index.chunks = "chunks.json";
    entries.push({ name: "chunks.json", read: () => json(written) });
  }

  entries.unshift({ name: "index.json", read: () => json(index) });
  return entries;
}
