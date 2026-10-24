// @polaris-key/protocol/sync — Cloud Sync on the wire. Types and constants only, no runtime, no
// crypto. Created by U-05.1 (plans/U-01.md §2.6 as amended by plans/U-01b.md §2.5): the one home
// of Cloud Sync's wire shapes and platform numbers, which the catalog and client-core re-export
// with their values unchanged. WIRE-CONTRACT-V4 §13 is the normative text; each export names its
// subsection.
//
// Nothing here is signed. `PROTOCOL_VERSION` stays 4. Constants are strings and integers only so
// that `gen constants` can emit them into every SDK (U-05.2). Saves-slot and file types are
// U-10's, and there is no `limits` member (§13.5).

/** A JSON value. */
export type SyncJson =
  | null
  | boolean
  | number
  | string
  | SyncJson[]
  | { [k: string]: SyncJson };

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** §8, §13.3 rule 4: `c_` + 22 base64url characters; one per (install, partition). */
export const SYNC_CLIENT_ID_PATTERN = "^c_[A-Za-z0-9_-]{22}$";
/** §8: `editedHlc`, 48-bit milliseconds and a 16-bit counter, lowercase hex. */
export const SYNC_HLC_PATTERN = "^[0-9a-f]{12}:[0-9a-f]{4}$";
/** §8, §13.2: a setting key, record id, slot or collection name. */
export const SYNC_KEY_PATTERN = "^[A-Za-z0-9._:-]{1,128}$";

/** §13.3: the most mutations one push carries (more is `400 bad_request`). */
export const SYNC_MAX_MUTATIONS = 100;
/** §13.3: the most bytes one push body carries (more is `413 body_too_large`). */
export const SYNC_MAX_PUSH_BYTES = 262_144;
/** §13.3: the server clamps an `editedHlc` later than `serverNow` plus this to `serverNow`. */
export const SYNC_MAX_CLOCK_SKEW_MS = 300_000;
/** §13.4, §13.6: tombstones last this many days; an older cursor is `410 cursor_expired`. */
export const SYNC_TOMBSTONE_DAYS = 90;

/** §11.5: the per-key debounce of a client `set`. */
export const SYNC_DEBOUNCE_MS = 2000;
/** §11.5: how long sign-out waits for its flush. */
export const SYNC_SIGNOUT_FLUSH_MS = 5000;
/** §11.5: days a signed-out partition keeps its pending operations. */
export const SYNC_PENDING_DAYS = 30;

/** §13.7: the most top-level members a `merge` setting or collection may declare. */
export const SYNC_MAX_MERGE_MEMBERS = 256;
/** §13.7: the longest canonical JSON of one `union` element, in bytes. */
export const SYNC_MAX_UNION_ELEMENT_BYTES = 1024;

/** §13.1: the most canonical-JSON bytes of one open setting value. */
export const SYNC_MAX_VALUE_BYTES = 8192;
/** §13.1: declared and open settings share one budget of this many keys per person. */
export const SYNC_MAX_SETTINGS = 256;
/** §13.1: ... and this many bytes per person. */
export const SYNC_MAX_SETTINGS_BYTES = 65_536;
/** §13.1, §13.7: a record, its metadata included. */
export const SYNC_MAX_RECORD_BYTES = 65_536;

/** §13.1, §13.7: save slots per person; no declaration or entitlement raises it. */
export const SYNC_SAVE_SLOTS = 16;
/** §13.1: a person's quota when nothing sets `pkey.cloudSync.bytes` (256 MiB). */
export const SYNC_QUOTA_BYTES = 268_435_456;
/** §13.1: a signed-in person with no usable licence, and no Anonymous devices tier (1 MiB). */
export const SYNC_UNLICENSED_QUOTA_BYTES = 1_048_576;

/** §11.5, §13.3: the clock every imported local value carries; any cloud value beats it. */
export const SYNC_IMPORT_HLC = "000000000000:0000";
/** §13.4: a pull page holds at most this many changes, with `more: true` while more remain. */
export const SYNC_PULL_PAGE_CHANGES = 500;
/** §13.9: `Retry-After` seconds of a `503 writes_paused` when the header is absent. */
export const SYNC_WRITES_PAUSED_RETRY_AFTER_SECONDS = 300;

// ---------------------------------------------------------------------------------------------
// Targets and operations (§13.3)
// ---------------------------------------------------------------------------------------------

/** §13.3: `user`, or `platform` (the server derives the platform family from the device row). */
export type SyncScope = "user" | "platform";

/** §13.3: a setting target. */
export interface SettingTarget {
  setting: string;
  scope: SyncScope;
}

/** §13.3: a record target, `[collection, id]` (U-09). */
export interface RecordTarget {
  record: [collection: string, id: string];
}

export type SyncTarget = SettingTarget | RecordTarget;

/** §13.3: every operation of the policy table; the target's policy decides which are legal. */
export type SyncOp =
  | "set"
  | "clear"
  | "setMember"
  | "removeMember"
  | "setField"
  | "removeField"
  | "delete"
  | "add"
  | "remove";

/** §13.3: one mutation of a push body. */
export interface SyncMutation {
  /** An integer from 1 to 2^53−1, strictly increasing per `clientId` (rule 4). */
  mutationId: number;
  target: SyncTarget;
  op: SyncOp;
  value?: SyncJson;
  /** `setMember` and `removeMember`. */
  member?: string;
  /** `setField` and `removeField`. */
  field?: string;
  /** `add` and `remove` on a `union` record. */
  element?: SyncJson;
  /** `remove` on a `union` record. */
  observedSeq?: number;
  /** A number is compare-and-swap, `"*"` create-only, absent unconditional. */
  baseVersion?: number | "*";
  editedHlc?: string;
}

/** §13.3: the push body. */
export interface PushRequest {
  clientId: string;
  cursor: number;
  atomic?: boolean;
  mutations: SyncMutation[];
}

// ---------------------------------------------------------------------------------------------
// Results (§13.3, §13.9)
// ---------------------------------------------------------------------------------------------

/** §13.3, §13.9: the `code` of a `rejected` result. */
export type SyncRejectCode =
  | "value_invalid"
  | "setting_not_synced"
  | "op_invalid_for_policy"
  | "collection_unknown"
  | "entitlement_required"
  | "quota_exceeded";

/** §13.3: the server's copy carried by a `conflict`. */
export interface SyncServerCopy {
  value: SyncJson;
  version: number;
  editedHlc?: string;
  members?: Record<string, SyncJson>;
}

/** §13.3: `{mutationId, status}` and the status's members. */
export type MutationResult =
  | {
      mutationId: number;
      status: "ok";
      version: number;
      /** A catalog migration renamed the key. */
      renamedTo?: string;
      /** A catalog migration dropped the key. */
      dropped?: true;
    }
  | { mutationId: number; status: "conflict"; server: SyncServerCopy }
  | {
      mutationId: number;
      status: "rejected";
      code: Exclude<SyncRejectCode, "quota_exceeded">;
    }
  | {
      mutationId: number;
      status: "rejected";
      code: "quota_exceeded";
      scope: "user" | "collection" | "product";
    }
  | { mutationId: number; status: "duplicate" }
  | { mutationId: number; status: "aborted" };

// ---------------------------------------------------------------------------------------------
// Pull and push answers (§13.3, §13.4)
// ---------------------------------------------------------------------------------------------

/** §13.4: the requesting device's resolved quota. */
export interface SyncQuota {
  bytes: number;
  files: boolean;
}

/** §13.4: the person's totals across their devices. */
export interface SyncUsage {
  bytes: number;
  settings: number;
  records: number;
  files: number;
}

/** §13.4: a setting change or a record change. */
export type SyncChange =
  | {
      setting: string;
      scope: SyncScope;
      value: SyncJson;
      version: number;
      editedHlc: string;
      updatedBy: string;
      members?: Record<string, SyncJson>;
    }
  | {
      record: [collection: string, id: string];
      value: SyncJson;
      version: number;
      editedHlc?: string;
    };

/** §13.4: `{setting}` or `{record}` with its `editedHlc`. */
export type SyncTombstone =
  | { setting: string; editedHlc: string }
  | { record: [collection: string, id: string]; editedHlc: string };

/** §13.4: the pull body, whose members a push `200` also carries. */
export interface PullResponse {
  subject: string;
  serverNow: number;
  cursor: number;
  more: boolean;
  lastMutationId: number;
  catalogVersion: number;
  aliases: Record<string, string>;
  quota: SyncQuota;
  usage: SyncUsage;
  /** Only on a cursor-0 answer for a principal with nothing stored. */
  empty?: true;
  changes: SyncChange[];
  tombstones: SyncTombstone[];
}

/** §13.3: the push `200` body: the results beside the pull members. */
export interface PushResponse extends PullResponse {
  results: MutationResult[];
}

/** §13.1: the `403 account_required` error body's members. */
export interface AccountRequiredBody {
  message: string;
  signInUrl: string;
}

// ---------------------------------------------------------------------------------------------
// Discovery (§13.5)
// ---------------------------------------------------------------------------------------------

/**
 * §13.5: `services.sync`. Each capability turns true, and its endpoint stops being `null`, only
 * from the release that serves it.
 */
export type SyncDiscovery =
  | { enabled: false }
  | {
      enabled: true;
      settings: boolean;
      collections: boolean;
      saves: boolean;
      endpoints: {
        pull: string | null;
        push: string | null;
        files: string | null;
      };
    };
