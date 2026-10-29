/**
 * The wire between the Worker and `CloudSyncDO` (U-05.6): one JSON `POST` per operation. Internal:
 * only `do/client.ts` (U-05.7) speaks it, and no member here is on the public wire (§13).
 *
 * Every request names the product and subject the Worker resolved. The object pins them on its
 * first write and refuses any other pair; a request can never choose a subject (the Worker takes
 * it from the authenticated principal).
 */

import type { PushRequest } from "@polaris-key/protocol/sync";
import type { PullOutcome } from "../engine/pull.js";
import type {
  Classification,
  MemberCell,
  PushLimits,
  PushOutcome,
  SettingPolicy,
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
  | (DoPin & { op: "usage" })
  /**
   * The console's read-only summary of what the object holds (U-11a.1). Names, counts and bytes
   * only: no value, no record id and no file name ever leaves the object through it.
   */
  | (DoPin & { op: "inspect" })
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

export interface ExportDocument {
  product: string;
  subject: string;
  seq: number;
  /** The write count (see `SqlStore.writeCount`): `seq` plus the writes that do not move it. */
  writes: number;
  watermark: number;
  usage: StoreUsage;
  /** Live rows and tombstones, in version order. */
  settings: ExportedSetting[];
  clients: { clientId: string; deviceId: string; lastMutationId: number }[];
}

/** One live setting as the console's summary sees it: its name and size, never its value. */
export interface InspectedSetting {
  key: string;
  scope: "user" | "platform";
  /** The platform family of a `platform`-scope row. */
  family?: string;
  /** What the quota charges for the row (`rowCost`). */
  bytes: number;
  /** The newest accepted write, milliseconds (the row's HLC). */
  updatedAt: number;
}

/**
 * One collection's counters, read from the records and files tables when the object has them
 * (they arrive with U-09 and U-10; an object without them answers none). `name` is the
 * collection's name in the clear; in end-to-end mode it is the only name an object holds.
 */
export interface InspectedCollection {
  name: string;
  records: number;
  bytes: number;
  files: number;
  fileBytes: number;
  revisionBytes: number;
  /** The newest record write, milliseconds, or null when no record carries a clock. */
  lastWriteAt: number | null;
}

/** Rows the object's SQL read and wrote for one operation (U-05.18). Counts only. */
export interface OpMeter {
  rowsRead: number;
  rowsWritten: number;
}

export type CloudSyncReply =
  | { op: "push"; outcome: PushOutcome; meter?: OpMeter }
  | { op: "pull"; outcome: PullOutcome; meter?: OpMeter }
  | { op: "usage"; usage: StoreUsage; seq: number; empty: boolean }
  | {
      op: "inspect";
      seq: number;
      empty: boolean;
      usage: StoreUsage;
      /** The store sequence from which every row is sealed, or null before the first sealed write. */
      encryptionSince: number | null;
      settings: InspectedSetting[];
      collections: InspectedCollection[];
      /** Uploads begun and not yet finalized, aborted or expired. */
      uploadsOpen: number;
    }
  | { op: "exportAll"; document: ExportDocument | null }
  | { op: "absorb"; changed: number; meter?: OpMeter }
  | { op: "deleteAll"; deleted: boolean };

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
