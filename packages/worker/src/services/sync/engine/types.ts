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

/** The conflict policies a record collection can carry (§13.6, `SyncConflict`). */
export type RecordPolicy =
  | "revision"
  | "lastWrite"
  | "max"
  | "min"
  | "merge"
  | "union";

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
  /**
   * The platform family (`desktop`, `mobile`, `console`, `web`) a `platform`-scope row belongs to:
   * one row per (key, family). Absent on `user` rows. A pull returns the user rows and the rows of
   * the asking device's own family (L9); the others stay stored, dormant and exported.
   */
  family?: string;
  /** The store sequence of the last accepted write; the pull's `version`. */
  version: number;
  /** The newest accepted write's stamp (`editedHlc` and `updatedBy`). */
  stamp: Stamp;
  deleted: boolean;
  /** A sealed row (end-to-end mode, §13.10) keeps its `ct` string here, and in each member cell. */
  value: SyncJson;
  members?: Map<string, MemberCell>;
  floor?: Stamp;
  /**
   * Derived, never stored: the row holds sealed values (its `version` is at or above the store's
   * `encryptionSince`). Sealed rows are charged by `envelopeBytes - 113` against the budgets.
   */
  sealed?: boolean;
}

/** What a stored record holds: one value, `merge` field cells, or a `union` set's tagged elements. */
export type RecordKind = "value" | "fields" | "set";

/**
 * One field of a `merge` record. `removed` is a cell tombstone and keeps its stamp. In end-to-end
 * mode the name is blinded and `value` is the sealed `ct` (the same rule as a `MemberCell`).
 */
export interface FieldCell {
  value: SyncJson;
  removed: boolean;
  stamp: Stamp;
  /** The envelope's key id (hex of bytes 1 to 16) of a sealed write; absent for plaintext. */
  kid?: string;
}

/**
 * One element of a `union` record: the element as given (the value in server mode, the sealed
 * `ct` in E2E mode) and the store sequences of the adds that are still alive (its tags). An
 * element with no tag left is gone, so the map never holds one.
 */
export interface SetElement {
  element: SyncJson;
  tags: number[];
  kid?: string;
}

/**
 * One (collection, id) of a person's store (U-09). Tombstones (`deleted`) stay in the same
 * table with the clock of the delete, so an older write cannot resurrect the record.
 *
 * A record is a single value (`kind: "value"`: `revision`, `lastWrite`, `max`, `min`), field cells
 * (`"fields"`: `merge`, with `floor` the stamp of the delete) or tagged elements (`"set"`:
 * `union`). `collection` is the concrete name: a `prefix.*` declaration governs many of them.
 */
export interface StoredRecord {
  collection: string;
  id: string;
  /** The store sequence of the last accepted write; the pull's `version`. */
  version: number;
  /** The newest accepted write's stamp (`editedHlc` and the pushing clientId). */
  stamp: Stamp;
  deleted: boolean;
  kind: RecordKind;
  /** `kind: "value"`: the value (server mode) or the sealed `ct` string (E2E mode). */
  value: SyncJson;
  fields?: Map<string, FieldCell>;
  floor?: Stamp;
  elements?: Map<string, SetElement>;
  /** The envelope's key id of a sealed value record; absent for plaintext. */
  kid?: string;
  /** Derived, never stored: the row holds sealed values (`version` at or above `encryptionSince`). */
  sealed?: boolean;
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
  /** Rolls back every write made inside it, usage and watermark included, when `fn` throws. */
  transaction<T>(fn: () => T): T;
  /** The sequence of the last accepted write (0 for an empty store). */
  currentSeq(): number;
  /** Advances and returns the sequence. */
  nextSeq(): number;
  getClient(clientId: string): ClientRecord | undefined;
  putClient(record: ClientRecord): void;
  /** `family` selects the row of a `platform`-scope key; it is ignored for `user`. */
  getSetting(
    key: string,
    scope: SyncScope,
    family?: string,
  ): StoredSetting | undefined;
  putSetting(row: StoredSetting): void;
  /** Removes a row outright (tombstone collection only). */
  deleteSetting(key: string, scope: SyncScope, family?: string): void;
  /** Every row, tombstones included, whose `version` is above `seq`, in ascending `version`. */
  settingsAfter(seq: number): StoredSetting[];
  /**
   * One page of what a pull serves (SR-1 N12): the rows, tombstones included, above `seq` that a
   * device of `family` sees (every `user` row, and the `platform` rows of that family), in
   * ascending `version`, at most `limit` of them. A store pages in storage, never loading the rest.
   */
  settingsPageAfter(
    seq: number,
    family: string,
    limit: number,
  ): StoredSetting[];
  /**
   * One page of every row (any family), tombstones included, with `after < version <= through`, in
   * ascending `version`, at most `limit`. The housekeeping reads this way (U-05.9), never the
   * whole store at once.
   */
  settingsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredSetting[];
  /** `undefined` when the store holds no row of the record, tombstone or not. */
  getRecord(collection: string, id: string): StoredRecord | undefined;
  putRecord(row: StoredRecord): void;
  /** Removes a record outright, its cells and elements with it (tombstone collection only). */
  deleteRecordRow(collection: string, id: string): void;
  /**
   * One page of the records (tombstones included) above `seq`, in ascending `version`, at most
   * `limit`. Records belong to the person, not a platform family, so every device sees them all.
   */
  recordsPageAfter(seq: number, limit: number): StoredRecord[];
  /** One page of every record with `after < version <= through`, ascending, at most `limit`. */
  recordsPageThrough(
    after: number,
    through: number,
    limit: number,
  ): StoredRecord[];
  /** How many live (not deleted) records the concrete `collection` holds. */
  liveRecordCount(collection: string): number;
  /** How many record tombstones the store keeps: in the concrete `collection`, or all of them. */
  recordTombstoneCount(collection?: string): number;
  /**
   * The `limit` oldest record tombstones by clock (HLC, then clientId), in the concrete
   * `collection` or across all of them. The forgetting bounds read this way (§13.3).
   */
  oldestRecordTombstones(limit: number, collection?: string): StoredRecord[];
  /** No row at all, tombstones and records included. */
  isEmpty(): boolean;
  /** The object has held a live setting or record at some point (a tombstone alone does not count). */
  heldData(): boolean;
  /** How many client bindings the object keeps. */
  clientCount(): number;
  /**
   * Forgets the binding that pushed longest ago, if it has been idle since `cutoffSeconds` (epoch
   * seconds) or earlier. Returns whether one went.
   */
  dropIdleClient(cutoffSeconds: number): boolean;
  /** The person's running totals. The engine keeps them current; a store only holds them. */
  getUsage(): StoreUsage;
  setUsage(usage: StoreUsage): void;
  /**
   * The tombstone-GC watermark: a store sequence. Tombstones at or below it may be gone, so a
   * non-zero cursor below it can no longer be served (`410 cursor_expired`). 0 until a collection.
   */
  getWatermark(): number;
  setWatermark(seq: number): void;
  /**
   * `encryptionSince` (§13.10.7): the store sequence from which every row is sealed. `undefined`
   * until the first end-to-end write; rows below it are legacy plaintext. Set once.
   */
  getEncryptionSince(): number | undefined;
  setEncryptionSince(seq: number): void;
}

/**
 * What the person's store holds, kept as running counters. `bytes` is every kind together (the
 * quota's measure; files add to it in U-10), `settings` and `settingsBytes` are the settings
 * budget's (256 keys, 64 KiB), `records` and `recordBytes` the live records' count and stored
 * bytes (inside `bytes`). Tombstones cost nothing.
 */
export interface StoreUsage {
  settings: number;
  settingsBytes: number;
  records: number;
  recordBytes: number;
  bytes: number;
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
      /** The key is not declared by the catalog: the person names it, so nothing bounds the names. */
      open?: boolean;
      /** The Worker's schema check of the mutation's value (or member value) failed. */
      valueInvalid?: boolean;
      /** End-to-end mode: the mutation carries a sealed `ct`, which the object stores as given. */
      sealed?: boolean;
    }
  | {
      /**
       * A record target the catalog declares (U-09, §13.3 checks 1 to 3 passed): the matched
       * declaration's policy and limits. `valueInvalid` is check 4's request-only part (a schema
       * failure, a cap, a malformed envelope, a stray member); the object adds the checks that
       * need stored state (an `observedSeq` above the sequence) and then check 5, the policy's
       * operations.
       */
      verdict: "record";
      policy: RecordPolicy;
      /** The matched declaration's `maxRecords` (per concrete collection). */
      maxRecords: number;
      /** `max` and `min` in server mode: the number property the server compares. */
      conflictField?: string;
      valueInvalid?: boolean;
      /** End-to-end mode: the mutation carries a sealed `ct` (and blinded names). */
      sealed?: boolean;
    }
  | {
      verdict: "reject";
      code:
        | "setting_not_synced"
        | "collection_unknown"
        | "entitlement_required"
        | "encryption_mismatch";
    };

/**
 * What the Worker resolved about the person's room, per request. The engine decides nothing about
 * where these numbers come from (D5's quota resolution, the product ceiling flag).
 */
export interface PushLimits {
  /** The requesting device's quota in bytes (`0`: reads only). */
  quotaBytes: number;
  /** The product is past `cloudSync.ceiling.bytes`: a write that grows usage is refused. */
  productOverCeiling?: boolean;
  /**
   * The product has `users` at or past the users ceiling: an object that never held data is
   * refused growth (`quota_exceeded`, scope `product`); one that holds or held data is untouched.
   */
  usersAtCeiling?: boolean;
}

/**
 * The catalog's `cloudSync.migrations` (rule 6): a renamed key is written to its new name and
 * answers `renamedTo`; a dropped key answers `dropped: true` and writes nothing. Maps, not plain
 * objects: a key may be called `__proto__`.
 */
export interface CatalogMigrations {
  renamedTo: ReadonlyMap<string, string>;
  dropped: ReadonlySet<string>;
}

export interface PushInput {
  /** The device the request authenticated as; a clientId binds to the first one that uses it. */
  deviceId: string;
  /** The device row's platform family: the home of this request's `platform`-scope writes. */
  family?: string;
  /**
   * The Worker always sends the limits. Absent only where nothing is to be refused by quota
   * (tests, and U-05.8's absorb, which applies no refusal: L8). The settings budget always holds.
   */
  limits?: PushLimits;
  /** For each mutation, `classified` describes the key it resolves to after these. */
  migrations?: CatalogMigrations;
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
  /** The person's totals after this request. */
  usage: StoreUsage;
  /** Writes accepted and conflicts answered, for the daily counters (U-05.9). */
  counts: { accepted: number; conflicts: number };
}

export type PushOutcome = PushSuccess | PushFailure;
