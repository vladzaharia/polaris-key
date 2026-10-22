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
      family?: string;
      limits?: PushLimits;
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
    })
  | (DoPin & { op: "usage" })
  | (DoPin & { op: "exportAll" })
  | (DoPin & { op: "deleteAll" });

/** A stored row as JSON: members become `[name, cell]` pairs, in the engine's order. */
export type ExportedSetting = Omit<StoredSetting, "members"> & {
  members?: [string, MemberCell][];
};

export interface ExportDocument {
  product: string;
  subject: string;
  seq: number;
  watermark: number;
  usage: StoreUsage;
  /** Live rows and tombstones, in version order. */
  settings: ExportedSetting[];
  clients: { clientId: string; deviceId: string; lastMutationId: number }[];
}

export type CloudSyncReply =
  | { op: "push"; outcome: PushOutcome }
  | { op: "pull"; outcome: PullOutcome }
  | { op: "usage"; usage: StoreUsage; seq: number; empty: boolean }
  | { op: "exportAll"; document: ExportDocument | null }
  | { op: "deleteAll"; deleted: true };

export type CloudSyncError = {
  error: "bad_request" | "pin_mismatch" | "unsupported_schema";
};
