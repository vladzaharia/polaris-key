// The core of `cloudSync.export()` (WIRE-CONTRACT-V5 §13.12, `pkey-sync-export/1`): a readable,
// unencrypted zip of what an app synced, made on the device. This module plans the archive, then
// streams it into a `ZipSink`; it speaks to no network and no file. The host gives it
//
//   - the rows as the Worker served them (after the flushed pull with `more: false`),
//   - the root (end-to-end mode) or none (server mode), and the crypto port,
//   - a `ExportFileSource` that fetches stored bytes and chunk objects (`GET` with `Range` resume,
//     the hourly allowance, retries and their bounded wait are the source's: §13.12 "What is
//     read"), and
//   - a sink (`zipStore.ts`).
//
// Everything the Worker served is untrusted. A row that does not open is dropped and listed; a
// file that does not check is written as far as it checks and flagged `partial`; nothing aborts
// the export but a bound (`sync-export-too-large`, before the first byte), a source that throws,
// and a cancel.
//
// Memory. The plan keeps, per row, only the ids and sizes it needs (a row is opened again when its
// line is written), the settings map, the manifests of the chunked files and the chunk records.
// A file is read one segment (1 MiB + 16) or one chunk at a time with an incremental SHA-256 and
// CRC-32; the source's own piece size (a Range of up to 8 MiB) is the other term of the ~8 MiB
// peak.
//
// Order. The central directory lists the entries in the order of §13.12 (README, settings,
// records, files, files.json, index.json, data.json). The bytes are written in the order the data
// is known: a record line cites its file's size and SHA-256, so the files are streamed first.

import {
  SYNC_EXPORT_FORMAT,
  SYNC_EXPORT_ITEM_RESERVE_BYTES,
  SYNC_EXPORT_MAX_BYTES,
  SYNC_EXPORT_MAX_CHUNKS,
  SYNC_EXPORT_MAX_ENTRIES,
  SYNC_EXPORT_STORE_DIR,
  SYNC_EXPORT_ZIP_END_BYTES,
  SYNC_EXPORT_ZIP_ENTRY_BYTES,
  SYNC_MAX_CHUNKS_PER_FILE,
} from "@polaris-key/protocol/sync";
import { MAX_JSON_DEPTH } from "@polaris-key/protocol/core";
import { PolarisError } from "../errors.js";
import type { Json } from "../cloud-sync.js";
import { deriveCollKey, deriveFileKey, deriveKid } from "./crypto.js";
import type { SyncCryptoPort } from "./crypto.js";
import {
  FILE_HEADER_BYTES,
  FILE_SEGMENT_BYTES,
  FILE_STREAM_MAGIC,
  FILE_STREAM_VERSION,
  FILE_TAG_BYTES,
  plainFileSize,
  sealedFileSize,
} from "./fileStream.js";
import { openValue, openValueAnyName } from "./envelope.js";
import { blind } from "./blind.js";
import {
  MANIFEST_HEADER_BYTES,
  MANIFEST_RECORD_BYTES,
  parseManifest,
} from "./manifest.js";
import { Sha256 } from "./sha256.js";
import {
  SERVER_CHUNK_MAX_STORED_BYTES,
  e2eFileCodec,
  serverFileCodec,
  type FileCodec,
} from "./transferCodec.js";
import { openPull, type HostCodec } from "./hostCodec.js";
import { ZipStoreWriter, type ZipSink } from "./zipStore.js";

// ── input ────────────────────────────────────────────────────────────────────────────────────

/** A file pointer as the Worker served it: any field may be wrong, and the export validates it. */
export interface ExportFilePointer {
  version: number;
  size: unknown;
  sha256: unknown;
  format: unknown;
}

/** Names one stored file: the record's wire id (blinded in end-to-end mode) and a version. */
export interface ExportFileRef {
  collection: string;
  record: string;
  version: number;
}

/**
 * Where a file's stored bytes come from. The host implements it over its transport: whole files
 * as a `GET` with `Range` resume (the answer is one run of the stored bytes, however many requests
 * it took), chunks by id. A source throws what its transport throws (a cancel, a network error
 * after its bounded retries); the export never swallows that. A missing object is not a throw:
 * `chunk` answers null for a chunk the Worker does not have.
 */
export interface ExportFileSource {
  /** Every kept version of a record's file, including the current one, in any order. */
  pointers(
    collection: string,
    record: string,
  ): Promise<ReadonlyArray<ExportFilePointer>>;
  /** The stored bytes of a version: a whole file, or the manifest of a chunked one. The export
   *  stops reading (and calls the iterator's `return`) once it has what it plans for. */
  stored(ref: ExportFileRef): AsyncIterable<Uint8Array>;
  /** A chunk object by its id (hex), or null. */
  chunk(collection: string, idHex: string): Promise<Uint8Array | null>;
}

export interface ExportInput {
  product: string;
  /** The device clock, in milliseconds. */
  exportedAt: number;
  /** Edits not yet pushed. */
  unsynced: number;
  includeRevisions: boolean;
  /** Test and host overrides of the bounds; `maxBytes` is the zip32 total of §13.12. */
  caps?: { maxEntries?: number; maxBytes?: number };
  /** The changes of the pull as served (sealed in end-to-end mode): settings and records. */
  changes: ReadonlyArray<unknown>;
  /** The crypto port (chunk ids need it in both modes). */
  port: SyncCryptoPort;
  /** The ring root in end-to-end mode, null in server mode. */
  root: Uint8Array | null;
  /** The host's codec when it has one; omitted, one is made from the root. */
  codec?: HostCodec;
  files: ExportFileSource;
  signal?: AbortSignal;
}

export interface ExportSummary {
  /** Bytes sent to the sink. */
  bytes: number;
  /** The zip32 total the plan counted before the first byte. */
  plannedBytes: number;
  entries: number;
  /** What `data.json` counts. */
  counts: { settings: number; records: number; files: number };
  /** `data.json`'s `skipped`. */
  skipped: Array<{
    kind: string;
    collection?: string;
    entry?: string;
    code: string;
    partial?: boolean;
  }>;
  unsynced: number;
}

// ── fixed text ───────────────────────────────────────────────────────────────────────────────

export const SYNC_EXPORT_README = `This is a readable copy of data an app synced with Polaris Locker.

The app made it on this device. It is NOT encrypted: anyone who can open
this file can read everything in it. Keep it where you keep your other
private files, and delete it when you no longer need it. The time it was
made is "exportedAt" in data.json, in milliseconds since 1970-01-01 UTC.

Polaris Locker's own export of this data, from its website, uses the same
layout and holds the data as the app stored it: encrypted when the app
encrypts it.

data.json                              what this holds, and what could not be read
stores/sync.cloudSync/settings.json    the synced settings
stores/sync.cloudSync/records/         the synced records, one file a collection
stores/sync.cloudSync/index.json       which file holds which collection
stores/sync.cloudSync/files/           the synced files
stores/sync.cloudSync/files.json       which file belongs to which record

A file marked "partial" in data.json is incomplete or did not match what
the app stored. Do not rely on it.
`;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const enc = new TextEncoder();
const bytesOf = (s: string): number => enc.encode(s).length;
const byBytes = (a: string, b: string): number => {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isSize = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const isHex64 = (s: unknown): s is string =>
  typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
/** An object with no inherited members: `__proto__`, `constructor` are ordinary names. */
const nullObject = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>;
const own = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

const LONE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/;

class Unserialisable extends Error {}

/**
 * Canonical JSON (§13.10.3) with the refusals the export meets: a number that is not finite, a
 * string or key with a lone surrogate, and a nesting deeper than `max` (0: no limit), counted from
 * the outermost array or object as level 1. Keys sort by UTF-16 code unit and are read as own
 * properties only.
 */
function canon(v: unknown, max: number): string {
  const out: string[] = [];
  const emit = (x: unknown, level: number): void => {
    switch (typeof x) {
      case "string":
        if (LONE.test(x)) throw new Unserialisable("lone surrogate");
        out.push(JSON.stringify(x));
        return;
      case "number":
        if (!Number.isFinite(x)) throw new Unserialisable("not finite");
        out.push(JSON.stringify(x));
        return;
      case "boolean":
        out.push(x ? "true" : "false");
        return;
      case "object":
        break;
      default:
        throw new Unserialisable("type");
    }
    if (x === null) {
      out.push("null");
      return;
    }
    if (max > 0 && level >= max) throw new Unserialisable("depth");
    if (Array.isArray(x)) {
      out.push("[");
      x.forEach((item, at) => {
        if (at > 0) out.push(",");
        emit(item, level + 1);
      });
      out.push("]");
      return;
    }
    const keys = Object.keys(x).sort();
    out.push("{");
    keys.forEach((k, at) => {
      if (at > 0) out.push(",");
      emit(k, 0);
      out.push(":");
      emit((x as Record<string, unknown>)[k], level + 1);
    });
    out.push("}");
  };
  emit(v, 0);
  return out.join("");
}
/** True when a row's id, value and version have a canonical spelling. */
const writable = (r: OpenedRow): boolean =>
  serialisable(r.id) &&
  serialisable(r.hasValue ? r.value : null) &&
  safeVersion(r.version);
/** A served version is a count a reader of any language holds exactly: an integer past 2^53 - 1 is
 *  not one (a JSON reader rounds it), so its row is not written. */
const safeVersion = (v: unknown): boolean =>
  !(typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v));
const lineOf = (v: unknown): string => canon(v, 0) + "\n";
const serialisable = (v: unknown): boolean => {
  try {
    canon(v, MAX_JSON_DEPTH);
    return true;
  } catch {
    return false;
  }
};

const cancelled = (): PolarisError =>
  new PolarisError("cancelled", "The export was cancelled");
const tooLarge = (what: string): PolarisError =>
  new PolarisError("sync-export-too-large", `The export is too large: ${what}`);
const checkCancel = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw cancelled();
};

// ── opening rows ─────────────────────────────────────────────────────────────────────────────

const SETTINGS = "$settings";

function hostCodecOf(port: SyncCryptoPort, root: Uint8Array): HostCodec {
  return {
    locked: false,
    seal: () => Promise.reject(new Error("the export never seals")),
    open: (c, n, e, a) => openValue(port, root, c, n, e, a),
    openAny: (c, e) => openValueAnyName(port, root, c, e),
    blind: (k, ctx, n) => blind(port, root, k, ctx, n),
  };
}

interface Pointer {
  version: number;
  size: unknown;
  sha256: unknown;
  format: unknown;
}

interface Binding {
  sha256: string;
  size: number;
  format: "whole" | "chunks";
}

interface OpenedRow {
  id: string;
  version: unknown;
  hasValue: boolean;
  value?: unknown;
  binding: Binding | null;
}

type RowResult = OpenedRow | "omit" | "invalid" | "file-only";

function pointerOf(c: Record<string, unknown>): Pointer | undefined {
  const f = c["file"];
  return isObj(f) && typeof f["version"] === "number"
    ? (f as unknown as Pointer)
    : undefined;
}

/** Whether the sealed `$file` binding names this pointer's file. */
const namedBy = (b: Binding, f: Pointer): boolean =>
  f.sha256 === b.sha256 && f.size === b.size && f.format === b.format;

/** The `$file` binding of a sealed value, or null when it names no file a reader can use. */
function bindingOf(raw: unknown): Binding | null {
  if (!isObj(raw)) return null;
  const { sha256, size, format } = raw;
  if (!isHex64(sha256) || !isSize(size) || size === 0) return null;
  if (format !== "whole" && format !== "chunks") return null;
  return { sha256, size, format };
}

class Opener {
  private readonly host: HostCodec | null;
  constructor(inp: Pick<ExportInput, "port" | "root" | "codec">) {
    this.host =
      inp.root === null ? null : (inp.codec ?? hostCodecOf(inp.port, inp.root));
  }

  /** An opened change as the host codec opens a pull, or null when it does not open. */
  private async viaPull(
    c: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const { body, opened } = await openPull(
      { changes: [c as Json] },
      this.host as HostCodec,
    );
    const row = opened.changes?.[0];
    if (row === undefined || row.sealed !== true) return null;
    const e = (body as { changes: Json[] }).changes[0];
    return isObj(e) ? (e as Record<string, unknown>) : null;
  }

  async setting(
    c: Record<string, unknown>,
  ): Promise<{ name: string; value: unknown } | null> {
    const wire = c["setting"] as string;
    if (this.host === null) {
      const members = c["members"];
      if (isObj(members)) return { name: wire, value: members };
      return own(c, "value") ? { name: wire, value: c["value"] } : null;
    }
    if (!own(c, "ct") && !Array.isArray(c["members"])) return null;
    const e = await this.viaPull(c);
    if (e === null || typeof e["setting"] !== "string") return null;
    return { name: e["setting"], value: e["value"] };
  }

  async record(
    collection: string,
    wire: string,
    c: Record<string, unknown>,
  ): Promise<RowResult> {
    const pointer = pointerOf(c);
    if (this.host === null) {
      return {
        id: wire,
        version: c["version"] ?? null,
        hasValue: own(c, "value"),
        ...(own(c, "value") ? { value: c["value"] } : {}),
        binding: null,
      };
    }
    for (const shape of ["fields", "elements"] as const) {
      const cells = c[shape];
      if (Array.isArray(cells) && cells.length === 0) return "omit";
    }
    const sealedShape =
      Array.isArray(c["fields"]) ||
      Array.isArray(c["elements"]) ||
      typeof c["ct"] === "string";
    if (!sealedShape) {
      // A file and no value: nothing names the id, nothing binds the file.
      return c["ct"] === undefined && pointer !== undefined
        ? "file-only"
        : "invalid";
    }
    const e = await this.viaPull(c);
    const rec = e?.["record"];
    if (
      e === null ||
      !Array.isArray(rec) ||
      rec[0] !== collection ||
      typeof rec[1] !== "string"
    )
      return "invalid";
    let value = e["value"];
    let binding: Binding | null = null;
    if (typeof c["ct"] === "string" && isObj(value) && own(value, "$file")) {
      const { $file: raw, ...rest } = value as Record<string, unknown>;
      value = rest;
      binding = bindingOf(raw);
    }
    return {
      id: rec[1],
      version: c["version"] ?? null,
      hasValue: true,
      value,
      binding,
    };
  }
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────────

interface Row {
  collection: string;
  /** The wire id, which keys the row's files. */
  wire: string;
  id: string;
  /** The change as served: the row is opened again when its line is written. */
  change: Record<string, unknown>;
  pointer?: Pointer;
  binding: Binding | null;
  /** Bytes of the line without its `file` member. */
  lineBytes: number;
}

interface ManifestPlan {
  records: { id: Uint8Array; plainLen: number }[];
  plainSha256: Uint8Array;
}

interface Planned {
  row: Row;
  ref: ExportFileRef;
  file: Pointer;
  live: boolean;
  planned: number;
  manifest?: ManifestPlan;
}

interface Skipped {
  kind: "setting" | "record" | "file";
  code: "invalid" | "sync-file-invalid";
  collection?: string;
  entry?: string;
  partial?: true;
}

/** Reads a source's pieces up to `max` bytes in all; true in `over` when it had more. */
async function readBounded(
  src: AsyncIterable<Uint8Array>,
  max: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const parts: Uint8Array[] = [];
  let n = 0;
  let over = false;
  for await (const piece of src) {
    checkCancel(signal);
    if (n + piece.length > max) {
      over = true;
      break;
    }
    parts.push(piece);
    n += piece.length;
  }
  const bytes = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, over };
}

const sealedSizeOf = (plain: number): number | null => {
  try {
    return sealedFileSize(plain);
  } catch {
    return null;
  }
};

// ── the export ───────────────────────────────────────────────────────────────────────────────

/**
 * Plans the archive, refusing with `sync-export-too-large` before the first byte, then writes it
 * to `sink`. The caller commits (or discards) the sink's destination once this settles.
 */
export async function exportToSink(
  inp: ExportInput,
  sink: ZipSink,
): Promise<ExportSummary> {
  const root = inp.root;
  const e2e = root !== null;
  const port = inp.port;
  const opener = new Opener(inp);
  const encryption = e2e ? "e2e" : "server";
  const dir = SYNC_EXPORT_STORE_DIR;
  const maxEntries = inp.caps?.maxEntries ?? SYNC_EXPORT_MAX_ENTRIES;
  const maxBytes = inp.caps?.maxBytes ?? SYNC_EXPORT_MAX_BYTES;
  const reserve = SYNC_EXPORT_ITEM_RESERVE_BYTES;
  const settingSkips: Skipped[] = [];
  const recordSkips: Skipped[] = [];
  const fileSkips: Skipped[] = [];
  const partialSkips: Skipped[] = [];
  const signal = inp.signal;
  const fileCodecs = new Map<string, FileCodec>();
  const codecFor = (collection: string): FileCodec => {
    let c = fileCodecs.get(collection);
    if (c === undefined) {
      c =
        root === null
          ? serverFileCodec(port)
          : e2eFileCodec(port, root, collection);
      fileCodecs.set(collection, c);
    }
    return c;
  };

  const changes = inp.changes.filter(isObj);

  // Settings, in the byte order of the name the Worker served.
  const settingChanges = changes
    .filter((c) => typeof c["setting"] === "string")
    .sort((a, b) => byBytes(a["setting"] as string, b["setting"] as string));
  const settings = nullObject();
  let settingCount = 0;
  for (const c of settingChanges) {
    checkCancel(signal);
    const got = await opener.setting(c);
    if (got === null || !serialisable(got.name) || !serialisable(got.value))
      settingSkips.push({ kind: "setting", code: "invalid" });
    else {
      settings[got.name] = got.value;
      settingCount++;
    }
  }
  const settingsLine = enc.encode(lineOf(settings));

  // Records, a collection at a time, rows in the byte order of the wire id.
  const recordChanges = changes.filter(
    (c) =>
      Array.isArray(c["record"]) &&
      (c["record"] as unknown[]).length >= 2 &&
      typeof (c["record"] as unknown[])[0] === "string" &&
      typeof (c["record"] as unknown[])[1] === "string",
  );
  const refOf = (c: Record<string, unknown>): [string, string] =>
    c["record"] as [string, string];
  const collections = [...new Set(recordChanges.map((c) => refOf(c)[0]))].sort(
    byBytes,
  );
  const written: Array<{ collection: string; rows: Row[] }> = [];
  const fileOnly = new Map<string, Record<string, unknown>[]>();
  for (const collection of collections) {
    const rows: Row[] = [];
    const mine = recordChanges
      .filter((c) => refOf(c)[0] === collection)
      .sort((a, b) => byBytes(refOf(a)[1], refOf(b)[1]));
    for (const c of mine) {
      checkCancel(signal);
      const wire = refOf(c)[1];
      const r = await opener.record(collection, wire, c);
      if (r === "omit") continue;
      if (r === "file-only") {
        const l = fileOnly.get(collection) ?? [];
        l.push(c);
        fileOnly.set(collection, l);
        continue;
      }
      if (r === "invalid" || !writable(r)) {
        recordSkips.push({ kind: "record", code: "invalid", collection });
        continue;
      }
      const pointer = pointerOf(c);
      rows.push({
        collection,
        wire,
        id: r.id,
        change: c,
        ...(pointer === undefined ? {} : { pointer }),
        binding: r.binding,
        lineBytes: bytesOf(lineText(r, undefined)),
      });
    }
    rows.sort((a, b) => byBytes(a.id, b.id));
    if (rows.length > 0) written.push({ collection, rows });
  }

  // The manifests of every chunked file are fetched and checked before anything else is read.
  let chunkTotal = 0;
  /** The collection of every file pointer the machine holds that the plan met. */
  const pointerCollections: string[] = [];
  const validate = async (
    collection: string,
    ref: ExportFileRef,
    f: Pointer,
  ): Promise<{ planned: number; manifest?: ManifestPlan } | null> => {
    if (!isSize(f.size) || !isHex64(f.sha256)) return null;
    const codec = codecFor(collection);
    if (f.format === "whole") {
      if (!e2e) return { planned: f.size };
      const plain = plainFileSize(f.size);
      return plain === null ? null : { planned: plain };
    }
    if (f.format !== "chunks") return null;
    const manifestMax = codec.storedSize(
      MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * SYNC_MAX_CHUNKS_PER_FILE,
    );
    const got = await readBounded(inp.files.stored(ref), manifestMax, signal);
    if (got.over) return null;
    const hash = new Sha256().update(got.bytes).digest();
    if (toHex(hash) !== f.sha256) return null;
    const opened = await codec.openManifest(got.bytes);
    if (!opened.ok) return null;
    const m = parseManifest(opened.plain);
    if (!m.ok) return null;
    if (codec.storedSize(m.manifest.plainSize) !== f.size) return null;
    const { plainSize, records, plainSha256 } = m.manifest;
    chunkTotal += records.length;
    const manifest: ManifestPlan = { records, plainSha256 };
    return { planned: plainSize, manifest };
  };

  // The plan: every file entry, live first and then the revisions, newest first.
  const planned: Planned[] = [];
  const stopAt = (): boolean => chunkTotal > SYNC_EXPORT_MAX_CHUNKS;
  for (const collection of collections) {
    const noEntry = (): void => {
      pointerCollections.push(collection);
      fileSkips.push({ kind: "file", code: "sync-file-invalid", collection });
    };
    for (const _ of fileOnly.get(collection) ?? []) noEntry();
    const rows = written.find((w) => w.collection === collection)?.rows ?? [];
    for (const row of rows) {
      if (row.pointer === undefined) continue;
      checkCancel(signal);
      if (e2e && row.binding === null) {
        // A file the sealed value does not name is no readable file there (§13.10.4).
        noEntry();
        delete row.pointer;
        continue;
      }
      const current = row.pointer;
      const others = (await inp.files.pointers(collection, row.wire)).filter(
        (f) => f.version !== current.version,
      );
      const older = [...others].sort((a, b) => b.version - a.version);
      const candidates: Pointer[] = [current, ...older];
      for (const _ of candidates) pointerCollections.push(collection);
      const { binding } = row;
      const live = candidates.find((f) =>
        binding === null ? f === current : namedBy(binding, f),
      );
      const mark = async (f: Pointer, isLive: boolean): Promise<void> => {
        const ref = { collection, record: row.wire, version: f.version };
        const v = stopAt() ? null : await validate(collection, ref, f);
        if (v === null) {
          fileSkips.push({
            kind: "file",
            code: "sync-file-invalid",
            collection,
          });
          if (isLive) delete row.pointer;
          return;
        }
        planned.push({
          row,
          ref,
          file: f,
          live: isLive,
          planned: v.planned,
          ...(v.manifest === undefined ? {} : { manifest: v.manifest }),
        });
      };
      // No candidate is the live file: the row has no readable file.
      if (live === undefined) {
        delete row.pointer;
        fileSkips.push({ kind: "file", code: "sync-file-invalid", collection });
        continue;
      }
      await mark(live, true);
      if (inp.includeRevisions)
        for (const f of candidates) if (f !== live) await mark(f, false);
    }
  }

  // The bounds, all before the first byte.
  const entryCount = 5 + written.length + planned.length;
  if (entryCount > maxEntries) throw tooLarge("too many entries");
  if (chunkTotal > SYNC_EXPORT_MAX_CHUNKS) throw tooLarge("too many chunks");
  let fileBytes = 0;
  for (const p of planned) {
    fileBytes += p.planned; // each term and the sum stay safe integers: stop at the cap
    if (fileBytes > maxBytes) throw tooLarge("files over the limit");
  }

  const liveRows = new Set(planned.filter((p) => p.live).map((p) => p.row));
  const indexText = (
    list: ReadonlyArray<{ collection: string; rows: Row[] }>,
  ): string =>
    lineOf({
      records: list.map(({ collection, rows }, i) => ({
        entry: `${dir}records/${i}.ndjson`,
        collection,
        count: rows.length,
      })),
    });
  let known = bytesOf(SYNC_EXPORT_README) + settingsLine.length;
  known += bytesOf(indexText(written));
  for (const { rows } of written)
    for (const r of rows)
      known += r.lineBytes + (liveRows.has(r) ? reserve : 0);
  // files.json and data.json depend on what the reads find: they count at their bound.
  known += 2 + planned.length;
  for (const p of planned)
    known += reserve + 6 * (bytesOf(p.row.collection) + bytesOf(p.row.id));
  known += reserve;
  for (const _ of settingChanges) known += reserve;
  for (const c of recordChanges) known += reserve + 6 * bytesOf(refOf(c)[0]);
  for (const c of pointerCollections) known += reserve + 6 * bytesOf(c);

  const names = entryNames(written.length, planned.length);
  const overhead =
    names.reduce(
      (a, n) => a + SYNC_EXPORT_ZIP_ENTRY_BYTES + 2 * bytesOf(n),
      0,
    ) + SYNC_EXPORT_ZIP_END_BYTES;
  const plannedBytes = fileBytes + known + overhead;
  if (plannedBytes > maxBytes) throw tooLarge("over the size limit");

  // ── write ──────────────────────────────────────────────────────────────────────────────────

  const zip = new ZipStoreWriter(sink);
  await zip.addBytes("README.txt", enc.encode(SYNC_EXPORT_README));
  await zip.addBytes(`${dir}settings.json`, settingsLine);

  // The files, read one at a time, in plan order, at most the planned size each.
  const fileIndex: unknown[] = [];
  const lineFile = new Map<Row, unknown>();
  for (let n = 0; n < planned.length; n++) {
    checkCancel(signal);
    const p = planned[n]!;
    const entry = `${dir}files/${n}.bin`;
    await zip.begin(entry);
    const r = await readFile(
      p,
      zip,
      inp.files,
      codecFor(p.row.collection),
      port,
      root,
      signal,
    );
    await zip.end();
    if (r.partial)
      partialSkips.push({
        kind: "file",
        code: "sync-file-invalid",
        collection: p.row.collection,
        entry,
        partial: true,
      });
    // What the archive holds of this file, as the record's `file` member and as a files.json item.
    const facts = nullObject();
    Object.assign(facts, {
      entry,
      version: p.file.version,
      size: r.size,
      sha256: r.sha256,
    });
    if (r.partial)
      Object.assign(facts, { partial: true, expectedSize: p.planned });
    fileIndex.push({
      ...facts,
      collection: p.row.collection,
      id: p.row.id,
      live: p.live,
      ...(e2e && !p.live ? { bound: false } : {}),
    });
    if (p.live) lineFile.set(p.row, facts);
  }

  // The record files, a line at a time: each row is opened again for its line.
  const indexRecords: Array<{
    entry: string;
    collection: string;
    count: number;
  }> = [];
  let recordCount = 0;
  for (let i = 0; i < written.length; i++) {
    const { collection, rows } = written[i]!;
    const name = `${dir}records/${i}.ndjson`;
    await zip.begin(name);
    for (const r of rows) {
      checkCancel(signal);
      const again = await opener.record(collection, r.wire, r.change);
      if (typeof again === "string")
        throw new PolarisError(
          "sync-export-failed",
          "A record changed while it was exported",
        );
      await zip.write(enc.encode(lineText(again, lineFile.get(r), r.id)));
      recordCount++;
    }
    await zip.end();
    indexRecords.push({ entry: name, collection, count: rows.length });
  }

  await zip.addBytes(`${dir}files.json`, enc.encode(lineOf(fileIndex)));
  await zip.addBytes(
    `${dir}index.json`,
    enc.encode(lineOf({ records: indexRecords })),
  );
  const data = {
    schema: SYNC_EXPORT_FORMAT,
    source: "device",
    product: inp.product,
    exportedAt: inp.exportedAt,
    encryption,
    counts: {
      settings: settingCount,
      records: recordCount,
      files: planned.length,
    },
    unsynced: inp.unsynced,
    skipped: [
      ...settingSkips,
      ...recordSkips,
      ...fileSkips,
      ...partialSkips,
    ].map((s) => ({ ...s })),
  };
  const dataBytes = enc.encode(lineOf(data));
  await zip.addBytes("data.json", dataBytes);
  const { bytes } = await zip.finish(names);
  if (bytes > plannedBytes)
    throw new Error("the export plan undercounted the archive");
  return {
    bytes,
    plannedBytes,
    entries: names.length,
    counts: data.counts,
    skipped: data.skipped,
    unsynced: inp.unsynced,
  };
}

/** Every entry's name, in the order a reader lists them. */
function entryNames(records: number, files: number): string[] {
  const dir = SYNC_EXPORT_STORE_DIR;
  const run = (n: number, name: (i: number) => string): string[] =>
    Array.from({ length: n }, (_, i) => name(i));
  return [
    "README.txt",
    `${dir}settings.json`,
    ...run(records, (i) => `${dir}records/${i}.ndjson`),
    ...run(files, (i) => `${dir}files/${i}.bin`),
    `${dir}files.json`,
    `${dir}index.json`,
    "data.json",
  ];
}

/** One record's line: `{id, version, value?, file?}`. `id` overrides the opened id (the plan). */
function lineText(r: OpenedRow, file: unknown, id?: string): string {
  const o = nullObject();
  o["id"] = id ?? r.id;
  o["version"] = r.version;
  if (r.hasValue) o["value"] = r.value;
  if (file !== undefined) o["file"] = file;
  return lineOf(o);
}

// ── reading one file ─────────────────────────────────────────────────────────────────────────

/** A file may take ceil(planned / this) + 8 requests of its source: a hostile Worker serving
 *  one-byte ranges ends the file as partial instead of holding the export for ever. */
const EXPORT_PIECE_FLOOR_BYTES = 64 * 1024;

/** A reader over a source that yields at most `limit` bytes, hashing what it yields. */
class Limited {
  private readonly it: AsyncIterator<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);
  private done = false;
  total = 0;
  readonly hash = new Sha256();
  /** The pieces asked of the source; a source that serves more than {@link pieceCap} ends the file. */
  private asked = 0;
  private readonly pieceCap: number;
  constructor(
    src: AsyncIterable<Uint8Array>,
    private readonly limit: number,
    private readonly signal?: AbortSignal,
  ) {
    this.it = src[Symbol.asyncIterator]();
    this.pieceCap = Math.ceil(limit / EXPORT_PIECE_FLOOR_BYTES) + 8;
  }

  /** Up to `n` bytes (fewer only at the end of the source or the limit). */
  async read(n: number): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let have = 0;
    while (have < n) {
      if (this.buf.length === 0) {
        if (this.done || this.total >= this.limit) break;
        checkCancel(this.signal);
        // A source that trickles tiny pieces would be asked for ever: past the cap the file is short.
        if (++this.asked > this.pieceCap) {
          this.done = true;
          break;
        }
        const r = await this.it.next();
        if (r.done) {
          this.done = true;
          break;
        }
        const room = this.limit - this.total;
        const piece =
          r.value.length > room ? r.value.subarray(0, room) : r.value;
        this.total += piece.length;
        this.hash.update(piece);
        this.buf = piece;
        if (piece.length === 0) continue;
      }
      const take = Math.min(n - have, this.buf.length);
      parts.push(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      have += take;
    }
    if (parts.length === 1) return parts[0]!;
    const out = new Uint8Array(have);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /** Stops the source: it is not read past what was planned. */
  async close(): Promise<void> {
    try {
      await this.it.return?.();
    } catch {
      // the source is done with either way
    }
  }
}

const nonce = (index: number, last: boolean): Uint8Array => {
  const n = new Uint8Array(12);
  n[0] = last ? 1 : 0;
  new DataView(n.buffer).setBigUint64(4, BigInt(index), false);
  return n;
};

async function readFile(
  p: Planned,
  zip: ZipStoreWriter,
  files: ExportFileSource,
  codec: FileCodec,
  port: SyncCryptoPort,
  root: Uint8Array | null,
  signal: AbortSignal | undefined,
): Promise<{ size: number; sha256: string; partial: boolean }> {
  const written = new Sha256();
  let size = 0;
  let partial = false;
  const put = async (b: Uint8Array): Promise<void> => {
    if (size + b.length > p.planned) throw new Error("read past the plan");
    written.update(b);
    size += b.length;
    await zip.write(b);
  };

  if (p.file.format === "chunks") {
    const m = p.manifest as ManifestPlan;
    const total = new Sha256();
    for (const rec of m.records) {
      checkCancel(signal);
      const object = await files.chunk(p.row.collection, toHex(rec.id));
      if (object === null || object.length > SERVER_CHUNK_MAX_STORED_BYTES) {
        partial = true;
        break;
      }
      const o = await codec.openChunk(rec.id, object);
      if (!o.ok || o.plain.length !== rec.plainLen) {
        partial = true;
        break;
      }
      total.update(o.plain);
      await put(o.plain);
    }
    if (!partial && toHex(total.digest()) !== toHex(m.plainSha256))
      partial = true;
    return { size, sha256: toHex(written.digest()), partial };
  }

  const stored = p.file.size as number;
  const src = new Limited(files.stored(p.ref), stored, signal);
  try {
    if (root === null) {
      // Server mode: the stored bytes are the plaintext.
      for (;;) {
        const piece = await src.read(FILE_SEGMENT_BYTES);
        if (piece.length === 0) break;
        await put(piece);
      }
      const digest = toHex(src.hash.digest());
      partial = src.total !== stored || digest !== p.file.sha256;
      return { size, sha256: toHex(written.digest()), partial };
    }
    // End-to-end: a segment at a time, each authenticated, the last known from the plan.
    const sync = port;
    const header = await src.read(FILE_HEADER_BYTES);
    const kid = await deriveKid(sync, root);
    const view = new DataView(header.buffer, header.byteOffset, header.length);
    let ok = header.length === FILE_HEADER_BYTES;
    if (ok)
      for (let i = 0; i < 8; i++)
        if (header[i] !== FILE_STREAM_MAGIC.charCodeAt(i)) ok = false;
    if (
      ok &&
      (view.getUint16(8, true) !== FILE_STREAM_VERSION ||
        view.getUint16(10, true) !== 0 ||
        view.getUint32(12, true) !== FILE_SEGMENT_BYTES ||
        toHex(header.subarray(16, 32)) !== toHex(kid))
    )
      ok = false;
    if (!ok) return { size, sha256: toHex(written.digest()), partial: true };
    const key = await deriveFileKey(
      sync,
      await deriveCollKey(sync, root, p.row.collection),
      header.subarray(32, 64),
    );
    const n = Math.max(1, Math.ceil(p.planned / FILE_SEGMENT_BYTES));
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const len =
        (last ? p.planned - i * FILE_SEGMENT_BYTES : FILE_SEGMENT_BYTES) +
        FILE_TAG_BYTES;
      const seg = await src.read(len);
      if (seg.length < len) {
        partial = true;
        break;
      }
      const plain = await sync.aesGcmOpen(key, nonce(i, last), header, seg);
      if (plain === null) {
        partial = true;
        break;
      }
      await put(plain);
    }
    if (!partial)
      partial =
        src.total !== stored || toHex(src.hash.digest()) !== p.file.sha256;
    return { size, sha256: toHex(written.digest()), partial };
  } finally {
    await src.close();
  }
}
