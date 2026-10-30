/**
 * The rows of a record's files and what they cost (U-10.9; WIRE-CONTRACT-V5 §13.8, GF1 and GF4),
 * kept apart from `files.ts` so the record engine can use them: `files.ts` reads `records.ts`
 * (`casMismatch`), and the delete path in `records.ts` needs these.
 *
 * A file row is `live` (the one a record points at), a `revision` (an older version kept for
 * `keepRevisions`), `parked` (a file of a record an account merge parked) or `dead`: nothing points
 * at it any more and the alarm deletes its R2 object, then the row (U-10.10). A dead row costs
 * nothing: the quota is given back when a file dies, and the bytes go at the next alarm.
 */

import type { SyncFilePointer } from "@polaris-key/protocol/sync";
import type { StoredFile, SyncStore } from "./types.js";
import { fileUsage } from "./usage.js";

/** The pointer a pull, a conflict copy and `finalize` carry for a stored file. */
export const filePointer = (f: StoredFile): SyncFilePointer => ({
  version: f.version,
  size: f.size,
  sha256: f.sha256,
  format: f.format,
});

/** The pointer of the record's live file, or undefined when it has none. */
export function livePointer(
  store: SyncStore,
  collection: string,
  recordId: string,
): SyncFilePointer | undefined {
  const f = store.liveFile(collection, recordId);
  return f ? filePointer(f) : undefined;
}

/** Moves the file counters (and `bytes`, which holds the stored files) by the given deltas, never below zero. */
export function moveFileUsage(
  store: SyncStore,
  d: { files?: number; fileBytes?: number; revisionBytes?: number },
): void {
  const u = store.getUsage();
  const f = fileUsage(u);
  const floor = (n: number) => Math.max(0, n);
  store.setUsage({
    ...u,
    bytes: floor(u.bytes + (d.fileBytes ?? 0) + (d.revisionBytes ?? 0)),
    files: floor(f.files + (d.files ?? 0)),
    fileBytes: floor(f.fileBytes + (d.fileBytes ?? 0)),
    revisionBytes: floor(f.revisionBytes + (d.revisionBytes ?? 0)),
  });
}

/**
 * Retires one stored file: its row becomes `dead` (the alarm deletes the object) and its bytes
 * leave the counters it was in. A file that is already dead, or parked (parked bytes are counted
 * with the revisions), is handled by its status.
 */
export function killFile(store: SyncStore, f: StoredFile): void {
  if (f.status === "dead") return;
  store.putFile({ ...f, status: "dead" });
  if (f.status === "live")
    moveFileUsage(store, { files: -1, fileBytes: -f.size });
  else moveFileUsage(store, { revisionBytes: -f.size });
}

/**
 * A record `delete` also removes its file and every kept revision (GF4): the rows die, the bytes
 * are freed at the next alarm, and the quota frees with them. A parked copy's file is not the
 * record's: it stays with its parked copy. Returns how many files died.
 */
export function dropRecordFiles(
  store: SyncStore,
  collection: string,
  recordId: string,
): number {
  let n = 0;
  for (const f of store.filesOf(collection, recordId))
    if (f.status === "live" || f.status === "revision") {
      killFile(store, f);
      n++;
    }
  return n;
}

/**
 * Keeps the newest `keep` revisions of a record's file and retires the rest (`keepRevisions`, run
 * when a `finalize` makes a revision). The live file is never touched.
 */
export function pruneRevisions(
  store: SyncStore,
  collection: string,
  recordId: string,
  keep: number,
): number {
  const revisions = store
    .filesOf(collection, recordId)
    .filter((f) => f.status === "revision")
    .sort((a, b) => b.version - a.version);
  const doomed = revisions.slice(Math.max(0, keep));
  for (const f of doomed) killFile(store, f);
  return doomed.length;
}
