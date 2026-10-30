/**
 * The wire between the Worker and `CloudSyncDO` (U-05.6): one JSON `POST` per operation. Internal:
 * only `do/client.ts` (U-05.7) speaks it, and no member here is on the public wire (§13).
 *
 * Every request names the product and subject the Worker resolved. The object pins them on its
 * first write and refuses any other pair; a request can never choose a subject (the Worker takes
 * it from the authenticated principal).
 */

import type { RecordJoin } from "../engine/absorbRecords.js";
import type {
  BeginFileRequest,
  PushRequest,
  SyncUploadMode,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import type { PullOutcome } from "../engine/pull.js";
import type { BeginRefusal, FileLimits } from "../engine/files.js";
import type {
  Classification,
  FieldCell,
  MemberCell,
  ParkedRecord,
  PushLimits,
  PushOutcome,
  SetElement,
  SettingPolicy,
  StoredRecord,
  StoredSetting,
  StoreUsage,
} from "../engine/types.js";

export interface DoPin {
  product: string;
  subject: string;
}

/** The Map/Set form of `CatalogMigrations`, as JSON. */
export interface WireMigrations {
  renamedTo: [string, string][];
  dropped: string[];
}

export type CloudSyncOp =
  | (DoPin & {
      op: "push";
      deviceId: string;
      /** The device row's platform family; the object answers 400 without one (SR-1 N1). */
      family: string;
      /** The device row's own platform (never the request body); the object records it only if it is in the closed set. */
      platform?: string;
      /** The Worker always sends its limits; the object answers 400 without them (SR-1 N1). */
      /** The tier the quota came from, for the directory (U-05.9); absent until U-05.10 sends it. */
      tierId?: string;
      limits: PushLimits;
      migrations?: WireMigrations;
      request: PushRequest;
      classified: Classification[];
      /** The server clock, milliseconds. */
      serverNow: number;
    })
  | (DoPin & {
      op: "pull";
      cursor?: number;
      clientId?: string;
      deviceId: string;
      family: string;
      /** `"e2e"`: sealed rows leave as `ct` and the answer names `encryptionSince` (§13.4). */
      encryption?: "e2e" | "server";
    })
  /**
   * File uploads (U-10): the object owns the sessions and makes the R2 control calls; the Worker
   * streams the bytes. `fileBegin` is checks 5 to 7 of the plan's §2.3 and the reservation; the
   * Worker has made 1 to 4 and chosen the mode.
   */
  | (DoPin & {
      op: "fileBegin";
      /** A fresh session id (`up_` and 22 base64url characters), chosen by the Worker. */
      uploadId: string;
      deviceId: string;
      collection: string;
      recordId: string;
      request: BeginFileRequest;
      mode: Extract<SyncUploadMode, "single" | "multipart">;
      partBytes?: number;
      /** The matched declaration's `maxRecords`. */
      maxRecords: number;
      limits: FileLimits;
      serverNow: number;
    })
  | (DoPin & {
      op: "fileStatus";
      collection: string;
      recordId: string;
      uploadId: string;
      serverNow: number;
    })
  /**
   * The session a byte request belongs to: what the Worker needs to stream into R2 (the key, the
   * size, the hash, the multipart handle) and nothing it should take from the path. U-10.6.
   */
  | (DoPin & {
      op: "filePrepare";
      collection: string;
      recordId: string;
      uploadId: string;
      serverNow: number;
    })
  /** Records part `n` after the Worker streamed it, or forgets it (`etag` absent) when it did not verify. */
  | (DoPin & {
      op: "filePart";
      collection: string;
      recordId: string;
      uploadId: string;
      n: number;
      etag?: string;
      bytes?: number;
      serverNow: number;
    })
  | (DoPin & {
      op: "fileAbort";
      collection: string;
      recordId: string;
      uploadId: string;
      serverNow: number;
    })
  | (DoPin & { op: "usage" })
  | (DoPin & { op: "exportAll" })
  /**
   * The survivor of an account merge takes in the absorbed subject's export (U-05.8). Only the
   * store's `merge` hook sends it (`do/client.ts` `absorbCloudSync`); the pin names the SURVIVOR,
   * and the document must be of the same product and another subject. `policies` is the catalog's
   * policy per key where the caller knows it.
   */
  | (DoPin & {
      op: "absorb";
      document: ExportDocument;
      policies?: [string, SettingPolicy][];
      /** The declaration per concrete record collection, where the caller knows it (U-09.8). */
      recordPolicies?: [string, RecordJoin][];
    })
  /**
   * `ifSeq` and `ifWrites`: delete only while the store is still at that sequence and write count
   * (an absorbed object that changed since its export is kept, and the caller absorbs again).
   * `absorbedInto`, with them, leaves the merge's marker behind (SR-1 N3); a plain `deleteAll` is
   * an erasure and leaves nothing.
   */
  | (DoPin & {
      op: "deleteAll";
      ifSeq?: number;
      ifWrites?: number;
      absorbedInto?: string;
    });

/** A stored row as JSON: members become `[name, cell]` pairs, in the engine's order. */
export type ExportedSetting = Omit<StoredSetting, "members"> & {
  members?: [string, MemberCell][];
};

/** A stored record as JSON: cells and elements become `[name, value]` pairs, in the engine's order. */
export type ExportedRecord = Omit<StoredRecord, "fields" | "elements"> & {
  fields?: [string, FieldCell][];
  elements?: [string, SetElement][];
};

/** A parked copy as JSON, in the same form. */
export type ExportedParked = Omit<ParkedRecord, "fields" | "elements"> & {
  fields?: [string, FieldCell][];
  elements?: [string, SetElement][];
};

export interface ExportDocument {
  product: string;
  subject: string;
  seq: number;
  /** The write count (see `SqlStore.writeCount`): `seq` plus the writes that do not move it. */
  writes: number;
  watermark: number;
  /** The store's `encryptionSince` (§13.10.7); absent until its first sealed write. */
  encryptionSince?: number;
  usage: StoreUsage;
  /** Live rows and tombstones, in version order. */
  settings: ExportedSetting[];
  /** Live records and tombstones, in version order. Absent from an export made before U-09.8. */
  records?: ExportedRecord[];
  /** Copies earlier account merges parked (D3). Absent when there are none. */
  parked?: ExportedParked[];
  clients: { clientId: string; deviceId: string; lastMutationId: number }[];
}

/** Rows the object's SQL read and wrote for one operation (U-05.18). Counts only. */
export interface OpMeter {
  rowsRead: number;
  rowsWritten: number;
}

export type CloudSyncReply =
  | { op: "push"; outcome: PushOutcome; meter?: OpMeter }
  | { op: "pull"; outcome: PullOutcome; meter?: OpMeter }
  | { op: "fileBegin"; outcome: FileBeginOutcome }
  | { op: "fileStatus"; outcome: FileStatusOutcome }
  | { op: "fileAbort"; outcome: FileAbortOutcome }
  | { op: "filePrepare"; outcome: FilePrepareOutcome }
  | { op: "filePart"; outcome: FileAbortOutcome }
  | { op: "usage"; usage: StoreUsage; seq: number; empty: boolean }
  | { op: "exportAll"; document: ExportDocument | null }
  | { op: "absorb"; changed: number; skipped?: number; meter?: OpMeter }
  | { op: "deleteAll"; deleted: boolean };

/** `begin`'s answer (`BeginFileResponse` less nothing: the Worker sends it as it is). */
export type FileBeginOutcome =
  | {
      ok: true;
      uploadId: string;
      mode: SyncUploadMode;
      partBytes?: number;
      expiresAt: number;
    }
  | BeginRefusal;

/** `404` for a session that is not this record's, is unknown or ended; `410` once it expired. */
export type FileStatusOutcome =
  | { ok: true; status: UploadStatus }
  | { ok: false; error: "not_found" | "upload_expired" };

/** What the Worker streams against. `parts` is 1 for a `single` upload. */
export type FilePrepareOutcome =
  | {
      ok: true;
      key: string;
      mode: SyncUploadMode;
      size: number;
      sha256: string;
      partBytes: number | null;
      parts: number;
      multipartId: string | null;
    }
  | { ok: false; error: "not_found" | "upload_expired" };

export type FileAbortOutcome = { ok: true } | { ok: false; error: "not_found" };

export type CloudSyncError = {
  error:
    | "bad_request"
    | "pin_mismatch"
    | "unsupported_schema"
    /** The object could not set its cleanup alarm: the caller retries (a 5xx the Worker maps). */
    | "unavailable"
    /** The object was absorbed by an account merge: it takes no more writes (SR-1 N3). */
    | "absorbed";
};
