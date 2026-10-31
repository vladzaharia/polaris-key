// The transfer journal (U-22.1): what an interrupted file transfer needs to carry on after a kill.
// It is host-local state, never a wire shape, so it has no corpus family; the unit tests prove it.
// A record is versioned so a later layout can be told from this one: a reader refuses a version
// it does not know and leaves the record alone, rather than guess at it or delete it.
// Only uploads are journaled: a download resumes from the chunk cache (`chunks`) or restarts.
//
//   {v:1, id, kind, collection, record, uploadId, mode, partBytes, done[], sha256, size,
//    expiresAt, state}
//
//   id          the caller's stable transfer id (the key of the record)
//   kind        "upload"
//   record      the wire record id the file belongs to (blinded in E2E mode)
//   mode        "single", "multipart" or "chunks", as `begin` answered
//   partBytes   the size of every part but the last; null for `single` and `chunks`
//   done        part numbers the server holds, ascending (`[1]` once a `single` body is in);
//               always empty for `chunks`, whose progress the server's plan answers
//   sha256/size the stored bytes (ciphertext in E2E mode), as begun. For `chunks`, `size` is the
//               file's stored size and `sha256` the stored manifest's; a sealed manifest is
//               different on every run, so a `chunks` record is only ever used to abort its
//               upload before the next one begins
//   expiresAt   Unix seconds, from `begin`
//   state       "uploading" until every part is in, then "finalizing"; a finished transfer's
//               record is deleted

import {
  SYNC_FILE_MAX_BYTES,
  SYNC_MAX_PARTS,
} from "@polaris-key/protocol/sync";

export const TRANSFER_JOURNAL_VERSION = 1;

export type TransferJournalState = "uploading" | "finalizing";

export interface TransferJournalRecord {
  v: typeof TRANSFER_JOURNAL_VERSION;
  id: string;
  kind: "upload";
  collection: string;
  record: string;
  uploadId: string;
  mode: "single" | "multipart" | "chunks";
  partBytes: number | null;
  done: number[];
  sha256: string;
  size: number;
  expiresAt: number;
  state: TransferJournalState;
}

/** Where records live. The host picks the medium (a file at 0600, a keychain-adjacent store, IndexedDB); a value is plain JSON. `get` and `list` return what was stored, unchecked: the engine validates the version. */
export interface JournalStore {
  get(id: string): Promise<unknown | null>;
  put(id: string, record: TransferJournalRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** The ids held. */
  list(): Promise<string[]>;
}

export type TransferJournalInvalid = "version" | "shape";

export class TransferJournalError extends Error {
  constructor(
    readonly reason: TransferJournalInvalid,
    readonly found?: unknown,
  ) {
    super(`transfer journal: ${reason}`);
    this.name = "TransferJournalError";
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === "string" && x !== "";

/** The record, or a `TransferJournalError`: `version` for a `v` this build does not know, `shape` for anything else wrong. */
export function parseJournalRecord(raw: unknown): TransferJournalRecord {
  if (!isObject(raw)) throw new TransferJournalError("shape");
  if (raw.v !== TRANSFER_JOURNAL_VERSION)
    throw new TransferJournalError("version", raw.v);
  const { id, kind, collection, record, uploadId, mode, partBytes } = raw;
  const { done, sha256, size, expiresAt, state } = raw;
  if (
    !isText(id) ||
    kind !== "upload" ||
    !isText(collection) ||
    !isText(record) ||
    !isText(uploadId) ||
    (mode !== "single" && mode !== "multipart" && mode !== "chunks") ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > SYNC_FILE_MAX_BYTES ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    (state !== "uploading" && state !== "finalizing") ||
    !Array.isArray(done)
  )
    throw new TransferJournalError("shape");
  let parts = 1;
  if (mode === "multipart") {
    if (
      typeof partBytes !== "number" ||
      !Number.isSafeInteger(partBytes) ||
      partBytes < 1
    )
      throw new TransferJournalError("shape");
    parts = Math.max(1, Math.ceil(size / partBytes));
    if (parts > SYNC_MAX_PARTS) throw new TransferJournalError("shape");
  } else if (partBytes !== null) throw new TransferJournalError("shape");
  if (mode === "chunks" && done.length !== 0)
    throw new TransferJournalError("shape");
  let last = 0;
  for (const n of done) {
    if (!Number.isSafeInteger(n) || n <= last || n > parts)
      throw new TransferJournalError("shape");
    last = n;
  }
  return {
    v: TRANSFER_JOURNAL_VERSION,
    id,
    kind,
    collection,
    record,
    uploadId,
    mode,
    partBytes: mode === "multipart" ? (partBytes as number) : null,
    done: [...(done as number[])],
    sha256,
    size,
    expiresAt,
    state,
  };
}

/** An in-memory journal: tests, and a host with nothing durable to offer (a transfer then does not survive a kill). */
export function memoryJournal(): JournalStore {
  const map = new Map<string, string>();
  return {
    get: async (id) => {
      const s = map.get(id);
      return s === undefined ? null : JSON.parse(s);
    },
    put: async (id, record) => {
      map.set(id, JSON.stringify(record));
    },
    delete: async (id) => {
      map.delete(id);
    },
    list: async () => [...map.keys()],
  };
}
