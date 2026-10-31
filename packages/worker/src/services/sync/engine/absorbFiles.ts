/**
 * Absorb, files (U-10.10; plans/U-10-U-11a-slices.md §2.6): the survivor of an account merge takes
 * in the files of the absorbed person's records. The bytes do not move: a file row keeps its full
 * R2 key (`u/<product>/<subject>/o/<uploadId>`, the absorbed subject's prefix), and the SSE-C key
 * it was sealed under travels with it, so the survivor opens it as ever and an erasure of the
 * survivor deletes it (it remembers the subject, `absorbed_from`).
 *
 * What a file becomes depends on what happened to its record in the join (`absorbRecords.ts`):
 *
 *   wins     the absorbed record is the record now: its live file is the live one, the survivor's
 *            live file is demoted to a revision, and its revisions come along.
 *   behind   the survivor's record stayed: it keeps its live file; the absorbed live file and
 *            revisions are kept as revisions (S-17: never silently overwrite), or become the live
 *            file when the survivor's record had none.
 *   parked   the record collided and its copy was parked (D3): its files are parked with it.
 *   dead     the record is deleted on the survivor: GF4, its files go (the alarm deletes the bytes).
 *
 * A row is identified by its R2 key, so absorbing the same export again changes nothing. A file
 * gets a version of the survivor's own sequence (the absorbed store's means nothing here), in the
 * order it had. Usage moves with the rows: parked and kept files count with the revisions. Nothing
 * is refused for quota or `keepRevisions` (L8); the next `finalize` prunes.
 */

import { refFileChunks } from "./chunks.js";
import { moveFileUsage } from "./fileRows.js";
import type {
  FileStatus,
  StoredChunk,
  StoredFile,
  SyncStore,
} from "./types.js";

/**
 * The chunks of an absorbed store (U-37): its chunk rows, with their R2 keys (the bytes do not
 * move), and the chunk ids each of its file versions names.
 */
export interface ChunkImport {
  /** By `chunkRowKey(collection, chunkId)`. */
  chunks: ReadonlyMap<string, StoredChunk>;
  /** By `fileRefKey(collection, recordId, version)`, the version being the absorbed store's. */
  names: ReadonlyMap<string, readonly string[]>;
}

export const chunkRowKey = (collection: string, chunkId: string): string =>
  `${collection}\u0000${chunkId}`;
export const fileRefKey = (
  collection: string,
  recordId: string,
  version: number,
): string => `${collection}\u0000${recordId}\u0000${version}`;

/** What became of a record in the join, for its incoming files (see the file comment). */
export type FileMode = "wins" | "behind" | "parked" | "dead";

/** The incoming file rows of one record, from the absorbed export. */
export type FilesByRecord = Map<string, StoredFile[]>;

export const recordKey = (collection: string, id: string): string =>
  `${collection}\u0000${id}`;

/** Groups an export's file rows by record, parked rows apart (they follow their parked copies). */
export function groupFiles(files: readonly StoredFile[]): {
  byRecord: FilesByRecord;
  parked: StoredFile[];
} {
  const byRecord: FilesByRecord = new Map();
  const parked: StoredFile[] = [];
  for (const f of files) {
    if (f.status === "parked") parked.push(f);
    else if (f.status !== "dead") {
      const key = recordKey(f.collection, f.recordId);
      byRecord.set(key, [...(byRecord.get(key) ?? []), f]);
    }
  }
  return { byRecord, parked };
}

/**
 * Takes the incoming rows of one record in (see the file comment). `canMove` is false when the
 * record's pointer must not change (a legacy plaintext record of an end-to-end store: moving its
 * version would make the pull read its value as sealed). Returns whether anything was written.
 */
export function importRecordFiles(
  store: SyncStore,
  mode: FileMode,
  collection: string,
  recordId: string,
  incoming: readonly StoredFile[],
  keys: ReadonlyMap<string, Uint8Array>,
  canMove = true,
  chunkImport?: ChunkImport,
): boolean {
  const have = new Set(
    store.filesOf(collection, recordId).map((f) => f.objectKey),
  );
  let changed = false;
  let installedLive = false;
  for (const f of [...incoming].sort((a, b) => a.version - b.version)) {
    if (have.has(f.objectKey)) continue;
    have.add(f.objectKey);
    let status: FileStatus;
    if (mode === "parked") status = "parked";
    else if (mode === "dead") status = "dead";
    else if (
      f.status === "live" &&
      canMove &&
      !installedLive &&
      (mode === "wins" || store.liveFile(collection, recordId) === undefined)
    )
      status = "live";
    else status = "revision";

    if (status === "live") {
      const cur = store.liveFile(collection, recordId);
      if (cur) {
        store.putFile({ ...cur, status: "revision" });
        moveFileUsage(store, {
          files: -1,
          fileBytes: -cur.size,
          revisionBytes: cur.size,
        });
      }
      installedLive = true;
    }
    const version = store.nextSeq();
    store.putFile({ ...f, status, version });
    if (f.format === "chunks" && chunkImport)
      takeChunks(
        store,
        chunkImport,
        f,
        { ...f, version },
        status !== "dead",
        keys,
      );
    if (status === "live")
      moveFileUsage(store, { files: 1, fileBytes: f.size });
    else if (status !== "dead") moveFileUsage(store, { revisionBytes: f.size });
    if (status !== "dead" && f.ssecKid !== undefined) {
      const key = keys.get(f.ssecKid);
      if (key && !store.getSsecKey(f.ssecKid)) store.putSsecKey(f.ssecKid, key);
    }
    changed = true;
  }
  // A pull tells a client of a new live file only by moving the record's version.
  if (installedLive) {
    const r = store.getRecord(collection, recordId);
    if (r && !r.deleted) store.putRecord({ ...r, version: store.nextSeq() });
  }
  return changed;
}

/**
 * A file the survivor took in names chunks whose bytes stay under the absorbed subject's prefix.
 * Each chunk gets a row here if the survivor has none (a duplicate keeps the survivor's own object;
 * the other is swept with the absorbed prefix at an erasure). A file that is not dead takes a
 * reference on each chunk; a dead one takes none, so its chunks have no reference and the
 * collector deletes them by the key the row names.
 */
function takeChunks(
  store: SyncStore,
  imp: ChunkImport,
  from: StoredFile,
  as: StoredFile,
  reference: boolean,
  keys: ReadonlyMap<string, Uint8Array>,
): void {
  const ids = imp.names.get(
    fileRefKey(from.collection, from.recordId, from.version),
  );
  if (!ids) return;
  const named: string[] = [];
  for (const id of ids) {
    const incoming = imp.chunks.get(chunkRowKey(from.collection, id));
    if (!incoming) continue;
    if (!store.getChunk(from.collection, id)) {
      store.putChunk({ ...incoming, refs: 0, unrefAt: 0 });
      if (incoming.ssecKid !== undefined) {
        const key = keys.get(incoming.ssecKid);
        if (key && !store.getSsecKey(incoming.ssecKid))
          store.putSsecKey(incoming.ssecKid, key);
      }
    }
    named.push(id);
  }
  if (reference) refFileChunks(store, as, named);
}
