// @polaris-key/protocol/packs — packs on the wire (WIRE-CONTRACT-V4 §2.5.1, §2.5.2, §2.6, §2.7;
// plans/P4-01.md §2.3–§2.8). Types and patterns only, no runtime, no crypto.
//
// A pack release is one CI-signed `pkey-release+jws` record with `kind: "pack"`, its variants
// inside. Every object it names is pinned by an object ref `{sha256, bytes, size, codec}` over
// the stored bytes; per-file detail lives in hash-pinned side objects (`pkey-files/1`,
// `pkey-patch/1`). An app record names the packs it needs in `content`, and each build the
// packs it embeds in `builds[].embeds`. `PROTOCOL_VERSION` stays 4: P3-01 reserved these slots.
//
// Claims check structure and patterns only. A value outside a v1 vocabulary below makes the
// governed variant, delta or pack unusable on an SDK that lacks it, never the record invalid
// (plans/P4-01.md §2.2), so the vocabularies are what a v1 SDK acts on, not what a record may say.

import type { ReleasePin } from "./update.js";

// ── Patterns (plans/P4-01.md §2.3) ───────────────────────────────────────────────────────────

/** A pack's `type`: `<family>.<kind>`, e.g. `godot.pck`, `files.tree`. */
export const PACK_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9-]{0,31}$/;
/** Every extensible vocabulary token: activation, layout, codec, delta method and scope,
 *  delivery. A v1 SDK acts on its own values and finds the rest unusable. */
export const VOCAB_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** A side object's `format`: `<name>/<version>`, e.g. `pkey-files/1`. */
export const OBJECT_FORMAT_PATTERN = /^[a-z][a-z0-9-]{0,31}\/[1-9][0-9]{0,8}$/;
/** A `godot.pck` handler prefix, `res://…/`, at most 256 bytes. */
export const HANDLER_PREFIX_PATTERN =
  /^res:\/\/([A-Za-z0-9_][A-Za-z0-9 ._@+-]*\/)+$/;
/** The licence flag that gates a pack's objects: `dist_access.entitlement`'s pattern. */
export const ENTITLEMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** A variant axis name (`texture`, `locale`, `quality`, …). */
export const VARIANT_AXIS_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
/** A variant axis value (`s3tc`, `fr`, `hd`, …), compared by bytes. */
export const VARIANT_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,34}$/;
/** `requires.engine`: `godot-<major>.<minor>`. */
export const ENGINE_PATTERN = /^godot-[0-9]+\.[0-9]+$/;

// ── v1 vocabularies (plans/P4-01.md §2.2) ────────────────────────────────────────────────────

/** Pack types a v1 SDK can hold: `files.tree` everywhere, `godot.pck` in Godot. */
export const PACK_TYPES = ["godot.pck", "files.tree"] as const;
export type PackType = (typeof PACK_TYPES)[number];
/** `files.layout`: a single-file payload with offsets and gaps, or a directory of files. */
export const FILES_LAYOUTS = ["container", "tree"] as const;
export type FilesLayout = (typeof FILES_LAYOUTS)[number];
/** An object ref's `codec`: one zstd frame with its content size, or stored raw. */
export const CONTENT_CODECS = ["zstd", "none"] as const;
export type ContentCodec = (typeof CONTENT_CODECS)[number];
/** `deltas[].method` values v1 applies. */
export const PATCH_METHODS = ["zstd-patch-from"] as const;
export type PatchMethod = (typeof PATCH_METHODS)[number];
/** Method names reserved for later packages; v1 finds them infeasible. */
export const RESERVED_PATCH_METHODS = [
  "godot-delta-pck",
  "hdiffpatch",
  "bsdiff",
] as const;
/** `deltas[].scope`: the whole payload, or the per-entry set. */
export const PATCH_SCOPES = ["payload", "files"] as const;
export type PatchScope = (typeof PATCH_SCOPES)[number];
/** `content.expects[].delivery`; an unknown value is read as `on-demand`. */
export const PACK_DELIVERIES = ["essential", "prefetch", "on-demand"] as const;
export type PackDelivery = (typeof PACK_DELIVERIES)[number];
/** `handler.activation`. */
export const PACK_ACTIVATIONS = ["restart", "hot"] as const;
export type PackActivation = (typeof PACK_ACTIVATIONS)[number];
/** Variant axis names a v1 manifest may declare. */
export const VARIANT_AXES = ["texture", "locale", "quality"] as const;
export type VariantAxis = (typeof VARIANT_AXES)[number];

// ── Files and magic bytes (plans/P4-01.md §2.7, §2.8) ────────────────────────────────────────

/** zstd's dictionary magic, `37 A4 30 EC`, as lowercase hex. CI never publishes a
 *  `zstd-patch-from` delta whose base starts with it (§2.7 rule 5). */
export const ZSTD_DICTIONARY_MAGIC = "37a430ec";
/** A single-file payload `X`'s marker is `X` + this suffix, beside it. */
export const MARKER_SUFFIX = ".pkey.json";
/** A tree payload's marker, relative to its root; no files index lists it. */
export const TREE_MARKER_PATH = ".pkey/pack.json";
/** The content stamp a build embeds. */
export const CONTENT_STAMP_FILE = "pkey-content.json";

// ── The pack record (`kind: "pack"`, WIRE-CONTRACT-V4 §2.5.1) ────────────────────────────────

/** An object ref: the SHA-256 and length of the stored bytes, the decoded length, the codec.
 *  `codec: "none"` requires `bytes === size`. All four are required, even for `none`. */
export interface ObjectRef {
  /** 64 lowercase hex, of the stored bytes. */
  sha256: string;
  /** Stored length. */
  bytes: number;
  /** Decoded length. */
  size: number;
  /** `zstd` or `none` in v1; any `VOCAB_TOKEN_PATTERN` value verifies. */
  codec: string;
}

/** A variant's files-index reference: the stored `pkey-files/1` object, plus its gaps. */
export interface FilesRef extends ObjectRef {
  /** `pkey-files/1` in v1. */
  format: string;
  /** `container` or `tree` in v1. */
  layout: string;
  /** Required on `container`, refused on `tree`, optional on any other layout. */
  gaps?: ObjectRef;
}

/** A whole-payload delta: one bare `zstd --patch-from` frame. Its id is `artifact.sha256`. */
export interface PayloadDelta {
  method: string;
  scope: "payload";
  /** The base release's `payload.sha256`. */
  from: string;
  /** Base size plus payload size. */
  memBytes: number;
  artifact: { sha256: string; bytes: number };
}

/** A per-entry delta set: a `pkey-patch/1` descriptor and one packed data object. Its id is
 *  `patch.sha256`. */
export interface FilesDelta {
  method: string;
  scope: "files";
  from: string;
  /** The largest (base entry + new entry). */
  memBytes: number;
  patch: ObjectRef;
  data: { sha256: string; bytes: number };
}

/** The chunking parameters CI records in `chunks.params` (plans/P4-10.md §2.4). Informative:
 *  clients never read them, and they are never claims. */
export interface ChunkParams {
  chunker?: string;
  fileAware?: boolean;
  avgSize?: number;
  minSize?: number;
  maxSize?: number;
  padMerge?: number;
  bundleTarget?: number;
  bundleLayout?: string;
  zstdLevel?: number;
  [key: string]: unknown;
}

/** A variant's chunk-index reference (plans/P4-10.md §2.2): an object ref naming a binary
 *  `pkey-chunks/1` index. An unknown `format` or `codec` makes the chunk strategy unusable;
 *  other members are ignored (reserved, e.g. an index delta). */
export interface ChunksRef extends ObjectRef {
  /** `pkey-chunks/1` (`CHUNKS_FORMAT`). */
  format: string;
  params?: ChunkParams;
}

export interface PackVariant {
  /** 0–4 axis → value members; `{}` for an unvaried pack. */
  variant: Record<string, string>;
  /** A container's payload file, or a tree's `treeDigest` and total size. */
  payload: { size: number; sha256: string };
  /** The whole payload as one object (a tree's files concatenated in index order). */
  full: ObjectRef;
  files: FilesRef;
  deltas?: (PayloadDelta | FilesDelta)[];
  /** `engine` is the one v1 claim; other members are not claims. */
  requires?: { engine?: string; [key: string]: unknown };
  /** The chunk index (plans/P4-10.md §2.2); valid but ignored on a `tree`. */
  chunks?: ChunksRef;
}

/** A `pkey-release+jws` payload with `kind: "pack"`. A pack record never carries `builds`;
 *  `deliverable` is the pack id (`DELIVERABLE_ID_PATTERN`, at most 64 bytes, not `app`). */
export interface PackRecordDoc {
  schemaVersion: 1;
  aud: string;
  deliverable: string;
  kind: "pack";
  version: string;
  seq: number;
  issuedAt: number;
  minSupportedSeq?: number;
  tag?: string;
  channel?: string;
  title?: string;
  notes?: string;
  provenance?: { commit?: string; workflowRun?: string };
  type: string;
  formatVersion: number;
  handler?: { mountOrder?: number; prefixes?: string[]; activation?: string };
  /** The licence flag gating the pack's objects, a snapshot of its delivery gate. */
  entitlement?: string;
  variants: PackVariant[];
}

// ── The app record's `content` (WIRE-CONTRACT-V4 §2.5.2) ─────────────────────────────────────

/** One pinned pack release: the feed target's `release` shape, naming a pack record. */
export interface ContentPin {
  pack: string;
  release: ReleasePin;
}

export interface ContentExpect {
  pack: string;
  required: boolean;
  /** `essential`, `prefetch` or `on-demand` in v1; anything else reads as `on-demand`. */
  delivery: string;
}

/**
 * A hold (P4-12, CONTENT §6.1 "per-app-release overrides"; WIRE-CONTRACT-V4 §2.5.2): this app
 * release keeps a `compatible` pack at one release (`release` is a pin's shape, naming a pack
 * record), with an optional human-readable `reason`. Clients read holds with `holdsOf`
 * (plans/P4-13.md §2.4), beside the claims: a malformed list is unusable, never a claim failure.
 */
export interface ContentHold {
  pack: string;
  release: ReleasePin;
  reason?: string;
}

/** An app record's `content`, also the content stamp's body. `holds` is read beside the claims
 *  (`holdsOf`, plans/P4-13.md §2.4); `packChannels` is the Worker's alone. */
export interface AppContent {
  contentApi: number;
  pins: ContentPin[];
  expects: ContentExpect[];
  /** At most `MAX_CONTENT_PINS` holds; never a pinned pack. */
  holds?: ContentHold[];
}

// ── Side objects (WIRE-CONTRACT-V4 §2.6) ─────────────────────────────────────────────────────

export interface FilesIndexEntry {
  path: string;
  /** Container only. */
  offset?: number;
  size: number;
  /** Of the file's bytes. */
  sha256: string;
  /** The stored object of this file; `codec` is `zstd` or `none`. */
  blob: { sha256: string; bytes: number; codec: string };
}

/** `pkey-files/1`. */
export interface FilesIndexDoc {
  format: "pkey-files/1";
  layout: string;
  payload: { size: number; sha256: string };
  files: FilesIndexEntry[];
}

/** One `pkey-chunks/1` chunk record, as `parseChunkIndex` returns it:
 *  `[id (hex), len, clen, bundle, offset]` (plans/P4-10.md §2.3). */
export type ChunkRecord = [
  id: string,
  len: number,
  clen: number,
  bundle: number,
  offset: number,
];

/** A parsed `pkey-chunks/1` index (plans/P4-10.md §2.3). Every u64 is read as two u32 words and
 *  saturated at 2^53, so a bundle `size` or `payloadSize` never exceeds 9,007,199,254,740,992. */
export interface ChunkIndexDoc {
  /** Header flag bit 0 (informative). */
  fileAware: boolean;
  payloadSize: number;
  payloadSha256: string;
  /** In payload order. */
  records: ChunkRecord[];
  /** `[sha256 (hex), size]`, in table order. */
  bundles: [sha256: string, size: number][];
}

export interface PatchEntry {
  path: string;
  op: "delta" | "blob";
  /** On a `delta` entry: the base file's SHA-256. */
  from?: string;
  to: string;
  size: number;
  /** On a `blob` entry. */
  codec?: string;
  offset: number;
  length: number;
}

/** `pkey-patch/1`, the descriptor of a `files`-scope delta set. */
export interface PatchDoc {
  format: "pkey-patch/1";
  scope: "files";
  method: string;
  from: string;
  to: string;
  data: { sha256: string; bytes: number };
  entries: PatchEntry[];
}

/** `pkey-marker/1`: the compact pack record beside (or inside) an embedded payload. */
export interface MarkerDoc {
  format: "pkey-marker/1";
  packId: string;
  version: string;
  /** The pack record's compact JWS. */
  release: string;
}

/** `pkey-content/1`: the app record's `content`, embedded in every build. */
export interface ContentStampDoc extends AppContent {
  format: "pkey-content/1";
}
