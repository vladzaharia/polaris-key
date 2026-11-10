/**
 * A person's own export, read a bounded page at a time (U-12.4): the object's half of the portal's
 * JSON section and zip. `exportAll` (`cloudSyncDo.ts`) stays for account merges, which need the
 * whole document and the R2 keys; nothing here builds one.
 *
 * Every read is of this object's own rows, so the pin is the only authority: a request names a
 * collection and a cursor and never a key, a prefix or a subject. A page stops at `limit` rows or
 * about {@link PAGE_BYTES} of JSON, whichever is first (always at least one row), so memory is one
 * page whatever the person stored. Only a `chunks` page carries where bytes are (their R2 key and
 * SSE-C key), for the Worker to read; a file is read through `fileResolve`, which already answers
 * that for its own rows. No other member names a key.
 */
import { hexEncode } from "../../../platform/bytes.js";
import { reportedUsage } from "../engine/chunks.js";
import type { SqlStore } from "./sqlStore.js";
import type {
  ExportChunkSource,
  ExportCollection,
  ExportPageRequest,
  ExportPageResult,
  ExportSummary,
  ExportedFile,
  ExportedParked,
  ExportedRecord,
} from "./protocol.js";

/** The most rows a page may hold, and the most a caller may ask for. */
export const EXPORT_PAGE_ROWS = 500;
/** A page ends once its rows add up to this much JSON. */
const PAGE_BYTES = 1024 * 1024;

const size = (v: unknown): number => JSON.stringify(v).length;

/** Whether `v` is a safe non-negative integer (a cursor or a limit). */
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Whether `page` is a request this module serves; the object answers 400 to any other. */
export function validExportPage(page: unknown): page is ExportPageRequest {
  if (typeof page !== "object" || page === null) return false;
  const p = page as Record<string, unknown>;
  const limit = (): boolean =>
    isCount(p.limit) && p.limit >= 1 && p.limit <= EXPORT_PAGE_ROWS;
  switch (p.part) {
    case "summary":
      return true;
    case "records":
      return (
        typeof p.collection === "string" &&
        p.collection !== "" &&
        isCount(p.after) &&
        limit()
      );
    case "parked":
      return isCount(p.after) && limit();
    case "files":
      return (
        limit() &&
        (p.after === undefined ||
          (Array.isArray(p.after) &&
            p.after.length === 3 &&
            typeof p.after[0] === "string" &&
            typeof p.after[1] === "string" &&
            isCount(p.after[2])))
      );
    case "chunks":
      return (
        typeof p.collection === "string" &&
        p.collection !== "" &&
        typeof p.after === "string" &&
        limit()
      );
    default:
      return false;
  }
}

/** A record (or parked copy) as JSON: its cells and elements become `[name, value]` pairs. */
function asJson<T>(r: {
  fields?: Map<string, unknown>;
  elements?: Map<string, unknown>;
}): T {
  const { fields, elements, ...row } = r;
  return {
    ...row,
    ...(fields ? { fields: [...fields] } : {}),
    ...(elements ? { elements: [...elements] } : {}),
  } as T;
}

/** The leading rows of `rows` that fit one page, and whether it ended early. */
function fit<T>(rows: T[]): { rows: T[]; capped: boolean } {
  let bytes = 0;
  for (let i = 0; i < rows.length; i++) {
    bytes += size(rows[i]);
    if (bytes >= PAGE_BYTES && i + 1 < rows.length)
      return { rows: rows.slice(0, i + 1), capped: true };
  }
  return { rows, capped: false };
}

function summary(store: SqlStore): ExportSummary {
  const stats = new Map<string, ExportCollection>();
  const entry = (name: string): ExportCollection => {
    let c = stats.get(name);
    if (!c) {
      c = {
        name,
        records: 0,
        bytes: 0,
        files: 0,
        fileBytes: 0,
        revisionBytes: 0,
        lastWriteAt: null,
      };
      stats.set(name, c);
    }
    return c;
  };
  for (const c of store.inspectTables().collections) stats.set(c.name, c);
  for (const name of store.recordCollections()) entry(name);
  const chunks = store.referencedChunkTotals();
  for (const c of chunks) entry(c.collection);
  const since = store.getEncryptionSince();
  return {
    seq: store.currentSeq(),
    ...(since !== undefined ? { encryptionSince: since } : {}),
    usage: reportedUsage(store, store.getUsage()),
    settings: store.settingsAfter(0).map(({ members, ...row }) => ({
      ...row,
      ...(members ? { members: [...members] } : {}),
    })),
    collections: [...stats.values()].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    ),
    recordCollections: store.recordCollections(),
    tombstones: store.recordTombstoneCount(),
    parked: store.parkedCount(),
    files: store.exportableFileCount(),
    chunks,
    clients: store.clientsSeen(),
  };
}

/**
 * One page. The caller has migrated the store and checked the object is pinned and neither
 * absorbed nor erased (`cloudSyncDo.ts`): a summary is then of that person's rows, and every page
 * is empty for an object that has none.
 */
export function exportPage(
  store: SqlStore,
  page: ExportPageRequest,
  live: boolean,
): ExportPageResult {
  if (page.part === "summary")
    return { part: "summary", summary: live ? summary(store) : null };
  if (!live) {
    const none = { rows: [], next: null };
    return { part: page.part, ...none } as ExportPageResult;
  }
  switch (page.part) {
    case "records": {
      const got = store
        .recordsPageIn(page.collection, page.after, page.limit)
        .map(asJson<ExportedRecord>);
      const { rows, capped } = fit(got);
      return {
        part: "records",
        rows,
        next:
          capped || got.length === page.limit
            ? (rows[rows.length - 1]?.version ?? null)
            : null,
      };
    }
    case "parked": {
      const got = store
        .parkedPage(page.after, page.limit)
        .map(asJson<ExportedParked>);
      const { rows, capped } = fit(got);
      return {
        part: "parked",
        rows,
        next:
          capped || got.length === page.limit ? page.after + rows.length : null,
      };
    }
    case "files": {
      const got = store
        .exportableFiles(page.after, page.limit)
        .map((f): ExportedFile => {
          // The pointer only: no R2 key, no key id, no writer.
          const { objectKey, ssecKid, clientId, ...pointer } = f;
          void objectKey;
          void ssecKid;
          void clientId;
          return pointer;
        });
      const { rows, capped } = fit(got);
      const last = rows[rows.length - 1];
      return {
        part: "files",
        rows,
        next:
          last && (capped || got.length === page.limit)
            ? [last.collection, last.recordId, last.version]
            : null,
      };
    }
    case "chunks": {
      const fetched = store.referencedChunks(
        page.collection,
        page.after,
        page.limit,
      );
      const got = fetched.flatMap((c): ExportChunkSource[] => {
        const ssec =
          c.ssecKid !== undefined ? store.getSsecKey(c.ssecKid) : undefined;
        // Under a key this object no longer holds, a chunk cannot be opened: it is not listed.
        if (c.ssecKid !== undefined && !ssec) return [];
        return [
          {
            chunkId: c.chunkId,
            storedBytes: c.storedBytes,
            key: c.objectKey,
            ...(ssec ? { ssecKey: hexEncode(ssec) } : {}),
          },
        ];
      });
      const { rows, capped } = fit(got);
      // A page of unlisted chunks only still goes on from the last one it read.
      const resume = capped
        ? rows[rows.length - 1]?.chunkId
        : fetched[fetched.length - 1]?.chunkId;
      return {
        part: "chunks",
        rows,
        next:
          resume !== undefined && (capped || fetched.length === page.limit)
            ? resume
            : null,
      };
    }
  }
}
