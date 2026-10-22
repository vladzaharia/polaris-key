/**
 * The Cloud Sync engine's types (U-05.4; plans/U-05-slices.md §3). The engine is pure: it applies a
 * pre-classified batch to an abstract, synchronous `SyncStore` and does no I/O, so the same rules
 * run over the in-memory store in tests and over the Durable Object's SQLite store (U-05.6). The
 * wire shapes are `@polaris-key/protocol/sync`'s; nothing here is on the wire.
 */

import type {
  MutationResult,
  PushRequest,
  SyncJson,
  SyncScope,
} from "@polaris-key/protocol/sync";

/** The conflict policies a setting route can carry (§13.6; `union` is refused for settings). */
export type SettingPolicy = "lastWrite" | "max" | "min" | "merge";

/** A write's place in the total order: the HLC, with the clientId as the final tie-break. */
export interface Stamp {
  hlc: string;
  clientId: string;
}

/** One member of a `merge` setting. `removed` is a member tombstone and keeps its stamp. */
export interface MemberCell {
  value: SyncJson;
  removed: boolean;
  stamp: Stamp;
}

/**
 * One (key, scope) of a person's store. `deleted` rows are the tombstones: they keep the stamp of
 * the clear so an older write cannot resurrect the key ("a later edit wins over it").
 *
 * A row is scalar (`value`) or merged (`members` set, with `floor`, the stamp of the latest
 * `clear`). The engine converts losslessly between the two when a push arrives under the other
 * policy (a policy change rewrites nothing until someone writes the key).
 */
export interface StoredSetting {
  key: string;
  scope: SyncScope;
  /** The store sequence of the last accepted write; the pull's `version`. */
  version: number;
  /** The newest accepted write's stamp (`editedHlc` and `updatedBy`). */
  stamp: Stamp;
  deleted: boolean;
  value: SyncJson;
  members?: Map<string, MemberCell>;
  floor?: Stamp;
}

/** A clientId's binding (rule 4): the first device that pushed with it, and its last processed id. */
export interface ClientRecord {
  clientId: string;
  deviceId: string;
  lastMutationId: number;
}

/**
 * The engine's whole view of storage. Synchronous on purpose: the Durable Object's SQL API is
 * (`transactionSync`). `transaction` must roll every write made inside it back when `fn` throws.
 */
export interface SyncStore {
  transaction<T>(fn: () => T): T;
  /** The sequence of the last accepted write (0 for an empty store). */
  currentSeq(): number;
  /** Advances and returns the sequence. */
  nextSeq(): number;
  getClient(clientId: string): ClientRecord | undefined;
  putClient(record: ClientRecord): void;
  getSetting(key: string, scope: SyncScope): StoredSetting | undefined;
  putSetting(row: StoredSetting): void;
}

/**
 * What the Worker decided about one mutation before the engine sees it (the Worker resolves the
 * catalog; the object never does). `accept` carries the route the key resolved to; `reject` is a
 * refusal that needs no stored state.
 */
export type Classification =
  | {
      verdict: "accept";
      /** The route's scope: the target must name the same one. Open settings are `user`. */
      scope: SyncScope;
      policy: SettingPolicy;
      /** The Worker's schema check of the mutation's value (or member value) failed. */
      valueInvalid?: boolean;
    }
  | {
      verdict: "reject";
      code:
        | "setting_not_synced"
        | "collection_unknown"
        | "entitlement_required";
    };

export interface PushInput {
  /** The device the request authenticated as; a clientId binds to the first one that uses it. */
  deviceId: string;
  request: PushRequest;
  /** Parallel to `request.mutations`. */
  classified: readonly Classification[];
  /** The server clock, milliseconds. */
  serverNow: number;
}

/** A request-level failure: nothing is applied and the client's journal is kept (rule 1). */
export type PushFailure =
  | { ok: false; error: "client_mismatch" }
  | { ok: false; error: "bad_request"; reason: string };

export interface PushSuccess {
  ok: true;
  results: MutationResult[];
  /** The client's last processed mutation id after this request (rule 1). */
  lastMutationId: number;
  /** The store sequence after this request: the pull cursor a `200` carries. */
  seq: number;
  /** Writes accepted and conflicts answered, for the daily counters (U-05.9). */
  counts: { accepted: number; conflicts: number };
}

export type PushOutcome = PushSuccess | PushFailure;
