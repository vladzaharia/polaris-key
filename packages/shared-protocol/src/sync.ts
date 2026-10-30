// @polaris-key/protocol/sync — Cloud Sync on the wire. Types and constants only, no runtime, no
// crypto. Created by U-05.1 (plans/U-01.md §2.6 as amended by plans/U-01b.md §2.5): the one home
// of Cloud Sync's wire shapes and platform numbers, which the catalog and client-core re-export
// with their values unchanged. WIRE-CONTRACT-V4 §13 is the normative text; each export names its
// subsection.
//
// Nothing here is signed. `PROTOCOL_VERSION` stays 5. Constants are strings and integers only so
// that `gen constants` can emit them into every SDK (U-05.2), and there is no `limits` member
// (§13.5). U-33.2 adds the file routes, the end-to-end shapes and the key ring (WIRE-CONTRACT-V5
// §13.2-§13.4, §13.8-§13.11); every export of this file named SYNC_* is a generated constant.

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
// Files, end-to-end encryption and the key ring: constants (U-33.2)
// ---------------------------------------------------------------------------------------------

/** §8, §13.11: `rg_` + 22 base64url characters; one key ring per (product, subject). */
export const SYNC_RING_ID_PATTERN = "^rg_[A-Za-z0-9_-]{22}$";
/** §8, §13.10.2: a `kid` is 16 bytes, lowercase hex (32 characters) in JSON and raw in an envelope header. */
export const SYNC_KID_PATTERN = "^[0-9a-f]{32}$";
/** §8, §13.10.3: `x:` + the base64url of a 32-byte HMAC (43 characters), the blinded form of a person-chosen name. */
export const SYNC_BLINDED_NAME_PATTERN = "^x:[A-Za-z0-9_-]{43}$";
/** §8, §13.10.3: the prefix a declared key or collection name never starts with. */
export const SYNC_BLINDED_PREFIX = "x:";
/** §8, §13.8.3: 64 lowercase hex characters; an HMAC-SHA256 in E2E mode, the plain SHA-256 in server mode. */
export const SYNC_CHUNK_ID_PATTERN = "^[0-9a-f]{64}$";
/** §8, §13.11.5: the prefix of the Keychain service that backs up a root (`pkey-sync:<product>`). */
export const SYNC_KEYCHAIN_SERVICE_PREFIX = "pkey-sync:";

/** §13.8.1: a whole file up to this size is one `PUT` (mode `single`; 16 MiB). */
export const SYNC_SINGLE_PUT_MAX_BYTES = 16_777_216;
/** §13.8.1: the largest whole file (mode `multipart`; 1 GiB). */
export const SYNC_FILE_MAX_BYTES = 1_073_741_824;
/** §13.8.1: the smallest `partBytes` (8 MiB). */
export const SYNC_PART_MIN_BYTES = 8_388_608;
/** §13.8.1: the largest `partBytes` (64 MiB). */
export const SYNC_PART_MAX_BYTES = 67_108_864;
/** §13.8.1: `partBytes` rounds up to a multiple of this (1 MiB). */
export const SYNC_PART_ROUND_BYTES = 1_048_576;
/** §13.8.1: `partBytes` = max(8 MiB, ceil(size / this) rounded up to 1 MiB). */
export const SYNC_MAX_PARTS = 9999;
/** §13.8.1: a collection with `files.delta` sends a file of at least this size as chunks (1 MiB). */
export const SYNC_DELTA_MIN_FILE_BYTES = 1_048_576;
/** §13.8.2: an upload and its quota reservation live this long. */
export const SYNC_UPLOAD_TTL_SECONDS = 86_400;
/** §13.8.2: open uploads per person; the next `begin` is `429 rate_limited`. */
export const SYNC_MAX_OPEN_UPLOADS = 4;
/** §13.8.2: parts a client sends in parallel. */
export const SYNC_UPLOAD_PARALLELISM = 4;
/** §13.8.2: file transfers per device an hour (`begin` and whole-file `GET`). */
export const SYNC_FILE_TRANSFERS_PER_HOUR = 30;
/** §13.8.2: part and chunk requests per device a minute. */
export const SYNC_CHUNK_REQUESTS_PER_MINUTE = 600;
/** §13.8.2: chunks per file. */
export const SYNC_MAX_CHUNKS_PER_FILE = 16_384;
/** §13.8.2: chunk ids in one plan call. */
export const SYNC_CHUNK_PLAN_MAX_IDS = 1024;

/** §13.8.3: the content-defined chunker's minimum chunk size (64 KiB). */
export const SYNC_CDC_MIN_BYTES = 65_536;
/** §13.8.3: the chunker's average chunk size (256 KiB). */
export const SYNC_CDC_AVG_BYTES = 262_144;
/** §13.8.3: the chunker's maximum chunk size (1 MiB). */
export const SYNC_CDC_MAX_BYTES = 1_048_576;
/** §13.8.3: the gear table's seed, as in the pack chunker (0x9e3779b9). */
export const SYNC_CDC_GEAR_SEED = 2_654_435_769;

/** §13.10.4: an envelope is 49 bytes of header and tag plus the padded payload (`(length - 49) mod 64 = 0`). */
export const SYNC_ENVELOPE_FIXED_BYTES = 49;
/** §13.10.4: the payload is padded to a multiple of this. */
export const SYNC_ENVELOPE_PAD_BLOCK = 64;
/** §13.10.4: the most an envelope adds to a value (49 fixed and at most 64 of padding); budgets are charged on `envelopeBytes - 113`. */
export const SYNC_E2E_OVERHEAD_BYTES = 113;
/** §13.10.4: the segment size of a `pkey-sync-file/1` stream (1 MiB). */
export const SYNC_FILE_SEGMENT_BYTES = 1_048_576;
/** §13.10.4: the sealed value format. */
export const SYNC_VALUE_FORMAT = "pkey-sync-value/1";
/** §13.10.4: the sealed file stream format. */
export const SYNC_FILE_FORMAT = "pkey-sync-file/1";
/** §13.8.3: the stored chunk object format. */
export const SYNC_CHUNK_FORMAT = "pkey-sync-chunk/1";
/** §13.8.3: the chunk manifest format (the file of a `chunks` upload). */
export const SYNC_MANIFEST_FORMAT = "pkey-sync-chunks/1";
/** §13.8.3: the chunker's name. */
export const SYNC_CDC_FORMAT = "pkey-sync-cdc/1";
/** §13.11.1: the wrap format. */
export const SYNC_WRAP_FORMAT = "pkey-sync-wrap/1";

/** §13.11.2: reads of the recovery blob per device a day. */
export const SYNC_RECOVERY_READS_PER_DAY = 5;
/** §13.11.4: a reset keeps the old ring this many days, read-only. */
export const SYNC_RESET_KEEP_DAYS = 30;

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
  /** `setField` and `removeField` on a `merge` record. In E2E mode a blinded name (§13.10.3). */
  field?: string;
  /** `add` and `remove` on a `union` record. In E2E mode a blinded name (§13.10.3). */
  element?: SyncJson;
  /** §13.3, §13.10: the sealed value, a `pkey-sync-value/1` envelope in canonical base64url. Replaces `value` in E2E mode. */
  ct?: string;
  /** `remove` on a `union` record: the pull cursor the client held when it saw the element; a `remove` without it is `value_invalid` (§13.3). */
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
  | "quota_exceeded"
  | "encryption_mismatch";

/** §13.3: the server's copy carried by a `conflict`. */
export interface SyncServerCopy {
  /** Absent on a sealed copy (§13.10): `ct` replaces it. A legacy plaintext row keeps `value`. */
  value?: SyncJson;
  /** §13.3, §13.10: the sealed value of a row written in end-to-end mode. */
  ct?: string;
  version: number;
  editedHlc?: string;
  /** Plaintext members, or (end-to-end) `[{member, ct, editedHlc}]` with blinded names. */
  members?: Record<string, SyncJson> | SyncSealedMember[];
  /** §13.3 (U-09): a sealed `merge` record's cells, `[{field, ct, editedHlc}]` with blinded names. It replaces `ct`. */
  fields?: SyncSealedField[];
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

/**
 * §13.4: a setting change or a record change. In server mode a `merge` record's `value` is its live
 * object and a `union` record's an array in the order of each element's first surviving add tag
 * (U-09).
 */
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
export interface PullResponse extends Partial<PullEncryption> {
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
  changes: (SyncChange | SyncSealedChange)[];
  tombstones: SyncTombstone[];
}

/** §13.4, §13.10.1: a product's mode, set by the catalog's `cloudSync.encryption`. */
export type SyncEncryptionMode = "e2e" | "server";

/** §13.4, §13.10.7: the members an end-to-end pull adds; absent from an older Worker's answer. */
export interface PullEncryption {
  encryption: SyncEncryptionMode;
  /** The store sequence from which every row is sealed; a plaintext row below it is legacy data. */
  encryptionSince: number;
}

/**
 * §13.4: a sealed setting or record change; `ct` replaces `value`. A `merge` setting's `members`
 * are sealed, and so are a `merge` record's `fields` and a `union` record's `elements` (U-09).
 */
export type SyncSealedChange =
  | {
      setting: string;
      scope: SyncScope;
      /** Absent on a `merge` setting, whose sealed values are its `members`. */
      ct?: string;
      version: number;
      editedHlc: string;
      updatedBy: string;
      members?: SyncSealedMember[];
    }
  | {
      /** A `revision`, `lastWrite`, `max` or `min` record: one envelope under `k = id` (§13.10.4). */
      record: [collection: string, id: string];
      ct: string;
      version: number;
      editedHlc?: string;
    }
  | {
      /** A `merge` record (U-09): sealed cells and no `ct`; `editedHlc` is the newest of them. */
      record: [collection: string, id: string];
      fields: SyncSealedField[];
      version: number;
      editedHlc: string;
    }
  | {
      /** A `union` record (U-09): sealed elements in the order of each one's first surviving add tag, and no `ct`. */
      record: [collection: string, id: string];
      elements: SyncSealedElement[];
      version: number;
    };

/** §13.4: one field of a sealed `merge` record (U-09); `field` is blinded. Its `ct` seals under `k = id ‖ U+0000 ‖ field` (§13.10.4). */
export interface SyncSealedField {
  field: string;
  ct: string;
  editedHlc: string;
}

/** §13.4: one element of a sealed `union` record (U-09); `element` is blinded. Its `ct` seals under `k = id ‖ U+0000 ‖ canonicalJson(e)` (§13.10.4). */
export interface SyncSealedElement {
  element: string;
  ct: string;
}

/** §13.4: one member of a sealed `merge` setting; `member` is blinded. */
export interface SyncSealedMember {
  member: string;
  ct: string;
  editedHlc: string;
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
      /** §13.2, §13.10.1: absent on a Worker that cannot take `ct`; an app that requires E2E then stays local (`unsupported`). */
      encryption?: SyncEncryptionMode;
      endpoints: {
        pull: string | null;
        push: string | null;
        files: string | null;
        /** §13.2: `<base>/devices/keyring`, E2E only; absent on an old Worker. */
        keyring?: string | null;
      };
    };

// ---------------------------------------------------------------------------------------------
// Files (§13.2, §13.8)
//
// Routes (service `sync`, device bearer, `no-store`, under `/<p>/sync/files/{collection}/{id}`;
// `{id}` is the blinded record id in E2E mode):
//   POST   …/begin                              BeginFileRequest -> BeginFileResponse
//   PUT    …/upload/{uploadId}                  mode `single`: the bytes, `Content-Digest` -> 204
//   PUT    …/upload/{uploadId}/parts/{n}        mode `multipart`: part n (1…), `Content-Digest` -> 204
//   GET    …/upload/{uploadId}                  -> UploadStatus
//   DELETE …/upload/{uploadId}                  -> 204 (aborts, releases the reservation)
//   POST   …/upload/{uploadId}/chunks           ChunkPlanRequest -> ChunkPlanResponse
//   PUT    …/upload/{uploadId}/chunks/{chunkId} one chunk object, create-only -> 204
//   POST   …/finalize                           FinalizeRequest -> FinalizeResponse
//   GET    …/{id}[?version=]                    the stored file; `Range`/`206`, `ETag`, `Repr-Digest`
//   GET    …/{id}/revisions                     -> FileRevisionsResponse
//   GET    /<p>/sync/files/{collection}/chunks/{chunkId}   one chunk object
// ---------------------------------------------------------------------------------------------

/** §13.8.1: `whole` is one stream; `chunks` is a manifest over chunks (§13.8.3). */
export type SyncFileFormat = "whole" | "chunks";

/** §13.8.1: `e2e` or `none`; it must match the product's mode, else `400 encryption_mismatch`. */
export type SyncFileEnc = "e2e" | "none";

/** §13.8.1: how the bytes travel, chosen by the server at `begin`. */
export type SyncUploadMode = "single" | "multipart" | "chunks";

/** §13.8.1: the `begin` body. `sha256` is the hash of what is stored (ciphertext in E2E mode). */
export interface BeginFileRequest {
  size: number;
  sha256: string;
  format: SyncFileFormat;
  enc: SyncFileEnc;
  /** A number is compare-and-swap, `"*"` create-only, absent unconditional. */
  baseVersion?: number | "*";
}

/** §13.8.1: the `begin` answer. */
export interface BeginFileResponse {
  uploadId: string;
  mode: SyncUploadMode;
  /** `multipart` only. */
  partBytes?: number;
  expiresAt: number;
}

/** §13.8.2: the resume answer. `received` is for `multipart`, `missing` for `chunks`. */
export interface UploadStatus {
  mode: SyncUploadMode;
  size: number;
  partBytes?: number;
  received?: number[];
  missing?: string[];
  expiresAt: number;
}

/** §13.2: `[chunkId, storedBytes]`. */
export type SyncChunkRef = [chunkId: string, storedBytes: number];

/** §13.2: the chunk plan call, at most `SYNC_CHUNK_PLAN_MAX_IDS` ids. */
export interface ChunkPlanRequest {
  chunks: SyncChunkRef[];
}

/** §13.2: the chunks to send and the ones the person's collection already holds. */
export interface ChunkPlanResponse {
  missing: string[];
  present: SyncChunkRef[];
}

/** §13.8.1: the `finalize` body; idempotent per `uploadId`. */
export interface FinalizeRequest {
  uploadId: string;
}

/** §13.8.1: the `finalize` answer. */
export interface FinalizeResponse {
  version: number;
  size: number;
  sha256: string;
  format: SyncFileFormat;
}

/** §13.2: one kept revision of a record's file. */
export interface FileRevision {
  version: number;
  size: number;
  sha256: string;
  format: SyncFileFormat;
  createdAt: number;
}

/** §13.2: the revisions answer. */
export interface FileRevisionsResponse {
  revisions: FileRevision[];
}

/** §13.8.4: `409 upload_incomplete` carries what is still missing (part numbers or chunk ids). */
export interface UploadIncompleteBody {
  missing: (number | string)[];
}

/** §13.8.4: `409 revision_conflict` from `begin` or `finalize` carries the server's version. */
export interface FileRevisionConflictBody {
  server: { version: number };
}

// ---------------------------------------------------------------------------------------------
// The key ring (§13.11): Core's, served under `/<p>/devices/keyring`
//
//   GET    /<p>/devices/keyring                       -> KeyringResponse
//   POST   /<p>/devices/keyring                       CreateKeyringRequest -> 201
//   PUT    /<p>/devices/keyring/wraps/{deviceId}      PutWrapRequest -> 204 (create-only)
//   DELETE /<p>/devices/keyring/wraps/{deviceId}      -> 204 (the device's own wrap)
//   PUT    /<p>/devices/keyring/recovery              RecoveryBlob -> 204
//   GET    /<p>/devices/keyring/recovery              -> RecoveryBlob
//   POST   /<p>/devices/keyring/adopt                 AdoptRequest -> 204
//   POST   /<p>/devices/keyring/reset                 ResetKeyringRequest -> 201
// ---------------------------------------------------------------------------------------------

/** §13.11.1: the wrap's KEM; 0x0020 is X25519 (`pkey-sync-wrap/1`). The member is `kem` so a later key type changes one field. */
export type SyncWrapKem = string;

/** §13.11.2: a wrap of `R` to one device, as the server stores it. `enc` and `ct` are base64url. */
export interface KeyringWrap {
  epoch: number;
  kid: string;
  kem: SyncWrapKem;
  enc: string;
  ct: string;
  /** The device that made the wrap. */
  by: string;
}

/** §13.11.2: a root of another ring sealed under `K_adopt`. */
export interface KeyringAdopted {
  ringId: string;
  epoch: number;
  kid: string;
  ct: string;
}

/** §13.11.2: the ring as `GET` answers it. */
export interface KeyringRing {
  ringId: string;
  epoch: number;
  rootKid: string;
  state: string;
  createdAt: number;
  recovery: { set: boolean; createdAt: number | null };
  adopted: KeyringAdopted[];
  previous?: { ringId: string; kid: string; until: number };
}

/** §13.11.2: `GET /<p>/devices/keyring`; `wrap` is this device's, `null` while it has none. */
export interface KeyringResponse {
  ring: KeyringRing | null;
  wrap: KeyringWrap | null;
}

/** §13.11.4: the recovery blob (`0x01 ‖ n12 ‖ AES-256-GCM(K_rec, …)`), base64url. */
export interface RecoveryBlob {
  ct: string;
  epoch: number;
  kid: string;
}

/** §13.11.2: a wrap as a client sends it with a new ring. */
export interface NewKeyringWrap {
  kem: SyncWrapKem;
  enc: string;
  ct: string;
}

/** §13.11.2: `POST /<p>/devices/keyring`; `409 keyring_conflict` when a ring exists. */
export interface CreateKeyringRequest {
  ringId: string;
  rootKid: string;
  wrap: NewKeyringWrap;
  recovery?: { ct: string };
}

/** §13.11.2: `PUT /<p>/devices/keyring/wraps/{deviceId}`; `409 keyring_conflict` when a wrap exists. */
export interface PutWrapRequest {
  epoch: number;
  kid: string;
  kem: SyncWrapKem;
  enc: string;
  ct: string;
}

/** §13.11.2: `POST /<p>/devices/keyring/adopt`. */
export interface AdoptRequest {
  fromRingId: string;
  epoch: number;
  kid: string;
  ct: string;
}

/** §13.11.2: `POST /<p>/devices/keyring/reset`; the old ring becomes `previous` for `SYNC_RESET_KEEP_DAYS`. */
export type ResetKeyringRequest = CreateKeyringRequest;
