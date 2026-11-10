// The independent reference for `sync-vectors.json`'s `exportCases` (WIRE-CONTRACT-V5 §13.12,
// `pkey-sync-export/1`): what `cloudSync.export()` puts in the archive, restated from the spec as
// one whole-buffer function over node:crypto and `reference/syncVectors.ts` (the sealing
// reference). Nothing from client-core. The zip container is not pinned (D4), only the entries:
// their names, their order and their bytes, and the zip32 total they imply (§13.12 Bounds).
//
// Input: what the device holds after a flushed pull with `more: false`: the changes as served
// (sealed in end-to-end mode), the files' pointers and what the transport serves for them (a
// recipe), the kept revisions' pointers. Output: the entry list, or a refusal before the first
// byte.

import { createDecipheriv, createHash } from "node:crypto";
import {
  REF_CODEC_RAW,
  REF_FILE,
  REF_MANIFEST,
  cat,
  fromHex,
  refBlind,
  refChunkId,
  refEncodeManifest,
  refFilePlainSize,
  refKColl,
  refKFile,
  refKNames,
  refKid,
  refOpenChunk,
  refOpenFile,
  refOpenRecord,
  refOpenServerChunk,
  refOpenValueAnyName,
  refParseManifest,
  refSealChunk,
  refSealFile,
  refSealServerChunk,
  refStream,
  toHex,
  utf8,
  type RefRecordWire,
} from "./syncVectors.js";

export const REF_EXPORT = {
  format: "pkey-sync-export/1",
  storeDir: "stores/sync.cloudSync/",
  maxEntries: 65_000,
  maxBytes: 4_294_967_295,
  /** Most chunk records over every manifest of one export. */
  maxChunks: 65_536,
  /** The zip32 bytes an entry adds to its name's length twice and its data: 30 + 16 + 46. */
  zipEntryBytes: 92,
  zipEndBytes: 22,
  /** What a not-yet-known JSON item counts for in the plan, before 6 bytes per byte of its names. */
  itemReserveBytes: 1024,
  /** `MAX_JSON_DEPTH` (§1.2). */
  maxDepth: 64,
} as const;

/** The fixed text of `README.txt`: ASCII, LF, no interpolation. */
export const REF_EXPORT_README = `This is a readable copy of data an app synced with Polaris Locker.

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

// ── input ────────────────────────────────────────────────────────────────────────────────────

/** How a whole file's stored bytes are made: a deterministic plaintext, sealed when `saltHex` is given. */
export interface RefStoredRecipe {
  /** The literal label of `refStream(label, length)` (SHA-256(label ‖ u32be(i)) blocks). */
  label: string;
  length: number;
  /** End-to-end: the 32-byte salt of `pkey-sync-file/1`. Absent: server mode, the plaintext. */
  saltHex?: string;
  /** What the transport serves is these bytes of another plaintext (same length) instead, sealed under this salt. */
  swap?: { label: string; saltHex?: string };
  /** What the transport serves has this many more bytes after the stored ones. */
  extra?: number;
  /** What the transport serves is only the first `cut` bytes. */
  cut?: number;
  /** What the transport serves has the low bit of this byte flipped. */
  flipAt?: number;
}

/**
 * How a chunked file is made: the plaintext is `refStream(label, Σ chunkLens)` cut at `chunkLens`
 * (no CDC here), one raw (codec 0) chunk object each, a `pkey-sync-chunks/1` manifest over them,
 * sealed as a file stream under `saltHex` in end-to-end mode. The lies are the transport's.
 */
export interface RefChunkedRecipe {
  label: string;
  chunkLens: number[];
  saltHex?: string;
  /** The manifest's header says this `plainSize` instead of the sum. */
  manifestPlainSize?: number;
  /** The manifest's `plainSha256` has its first bit flipped. */
  plainSha256Flip?: boolean;
  /** The transport serves the stored manifest with the low bit of this byte flipped. */
  manifestFlipAt?: number;
  /** The transport serves no object for this chunk index. */
  dropChunk?: number;
  /** The transport serves this chunk's object with its last bit flipped. */
  flipChunk?: number;
}

export interface RefExportFile {
  collection: string;
  /** The record id as it is on the wire (blinded in end-to-end mode). */
  record: string;
  version: number;
  /** As served: any JSON value, validated by the export. */
  size: unknown;
  sha256: string;
  format: "whole" | "chunks";
  stored?: RefStoredRecipe;
  chunked?: RefChunkedRecipe;
}

export type RefExportChange = Record<string, unknown>;

export interface RefExportInput {
  product: string;
  exportedAt: number;
  encryption: "e2e" | "server";
  rootHex?: string;
  includeRevisions: boolean;
  unsynced: number;
  /** `maxBytes` is the zip32 total, not the file bytes. */
  caps?: { maxEntries?: number; maxBytes?: number };
  changes: RefExportChange[];
  files: RefExportFile[];
}

const S = REF_FILE.segmentBytes;

/** The stored size of a plaintext of `n` bytes as a `pkey-sync-file/1` stream. */
export const refPlainToSealed = (n: number): number =>
  REF_FILE.headerBytes + n + REF_FILE.tag * Math.max(1, Math.ceil(n / S));

/** The stored bytes of a whole file before the transport alters anything, and what it serves. */
export function refRecipeBytes(
  recipe: RefStoredRecipe,
  collection: string,
  rootHex: string | undefined,
): { full: Uint8Array; served: Uint8Array } {
  const seal = (label: string, saltHex: string | undefined): Uint8Array => {
    const plain = refStream(label, recipe.length);
    return saltHex === undefined
      ? plain
      : refSealFile(
          fromHex(rootHex as string),
          collection,
          fromHex(saltHex),
          plain,
        );
  };
  const full = seal(recipe.label, recipe.saltHex);
  let served: Uint8Array =
    recipe.swap === undefined
      ? full
      : seal(recipe.swap.label, recipe.swap.saltHex);
  if (recipe.extra !== undefined)
    served = cat(served, refStream(`${recipe.label} extra`, recipe.extra));
  if (recipe.flipAt !== undefined) {
    served = Uint8Array.from(served);
    served[recipe.flipAt] = (served[recipe.flipAt] ?? 0) ^ 0x01;
  }
  if (recipe.cut !== undefined) served = served.subarray(0, recipe.cut);
  return { full, served };
}

export interface RefChunkedBytes {
  plain: Uint8Array;
  /** The stored manifest before the transport alters it: what the pointer's `sha256` is of. */
  full: Uint8Array;
  served: Uint8Array;
  /** Chunk objects the transport serves, by id (hex). */
  objects: Map<string, Uint8Array>;
}

export function refChunkedBytes(
  recipe: RefChunkedRecipe,
  collection: string,
  rootHex: string | undefined,
): RefChunkedBytes {
  const root = rootHex === undefined ? null : fromHex(rootHex);
  const length = recipe.chunkLens.reduce((a, b) => a + b, 0);
  const plain = refStream(recipe.label, length);
  const records: { id: Uint8Array; plainLen: number }[] = [];
  const objects = new Map<string, Uint8Array>();
  let at = 0;
  recipe.chunkLens.forEach((len, i) => {
    const body = plain.subarray(at, at + len);
    at += len;
    const id = refChunkId(root, collection, body);
    records.push({ id, plainLen: len });
    if (recipe.dropChunk === i) return;
    let obj =
      root === null
        ? refSealServerChunk(REF_CODEC_RAW, body)
        : refSealChunk(root, collection, id, REF_CODEC_RAW, body);
    if (recipe.flipChunk === i) {
      obj = Uint8Array.from(obj);
      obj[obj.length - 1] = (obj[obj.length - 1] ?? 0) ^ 0x01;
    }
    objects.set(toHex(id), obj);
  });
  const plainSha256 = new Uint8Array(
    createHash("sha256").update(plain).digest(),
  );
  if (recipe.plainSha256Flip === true)
    plainSha256[0] = (plainSha256[0] ?? 0) ^ 1;
  const manifest = refEncodeManifest({
    plainSize: recipe.manifestPlainSize ?? length,
    plainSha256,
    records,
  });
  const full =
    root === null
      ? manifest
      : refSealFile(
          root,
          collection,
          fromHex(recipe.saltHex as string),
          manifest,
        );
  let served = full;
  if (recipe.manifestFlipAt !== undefined) {
    served = Uint8Array.from(full);
    served[recipe.manifestFlipAt] = (served[recipe.manifestFlipAt] ?? 0) ^ 0x01;
  }
  return { plain, full, served, objects };
}

// ── output ───────────────────────────────────────────────────────────────────────────────────

export interface RefExportEntry {
  name: string;
  bytes: Uint8Array;
}

export type RefExportResult =
  | {
      ok: true;
      entries: RefExportEntry[];
      /** The zip32 total the plan counted before the first byte, and the one the entries make. */
      plan: { total: number; actual: number };
    }
  | { ok: false; code: "sync-export-too-large" };

interface Skipped {
  kind: "setting" | "record" | "file";
  code: "invalid" | "sync-file-invalid";
  collection?: string;
  entry?: string;
  partial?: true;
}

/** The entry-name grammar of §13.12: the only names an export holds. */
export const REF_EXPORT_NAME =
  /^(README\.txt|data\.json|stores\/sync\.cloudSync\/(settings|files|index)\.json|stores\/sync\.cloudSync\/records\/(0|[1-9][0-9]*)\.ndjson|stores\/sync\.cloudSync\/files\/(0|[1-9][0-9]*)\.bin)$/;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const sha256 = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nullObject = (): Record<string, unknown> =>
  Object.create(null) as Record<string, unknown>;
const bytesOf = (s: string): number => Buffer.byteLength(s, "utf8");
const b64urlDecode = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? new Uint8Array(b) : null;
};
const isSize = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

const LONE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

class Unserialisable extends Error {}

/**
 * Canonical JSON (§13.10.3) with the refusals the export meets: a number that is not finite, a
 * string or key with a lone surrogate, and a nesting deeper than `max` (0: no limit). Keys sort by
 * UTF-16 code unit and are read as own properties only.
 */
function canon(v: unknown, max: number, depth = 0): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") {
    if (LONE.test(v)) throw new Unserialisable("lone surrogate");
    return JSON.stringify(v);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Unserialisable("not finite");
    return JSON.stringify(v);
  }
  if (typeof v === "object") {
    if (max > 0 && depth + 1 > max) throw new Unserialisable("depth");
    if (Array.isArray(v))
      return `[${v.map((x) => canon(x, max, depth + 1)).join(",")}]`;
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${canon(k, 0)}:${canon(o[k], max, depth + 1)}`)
      .join(",")}}`;
  }
  throw new Unserialisable("type");
}
const line = (v: unknown): Uint8Array => utf8(canon(v, 0) + "\n");
/** True when `v` and every name in it serialise, nested at most `maxDepth` deep. */
const serialisable = (v: unknown): boolean => {
  try {
    canon(v, REF_EXPORT.maxDepth);
    return true;
  } catch {
    return false;
  }
};

/** One `pkey-sync-file/1` stream read as the exporter reads it: a segment at a time, first failure stops. */
function openFileSegments(
  root: Uint8Array,
  collection: string,
  pointerSize: number,
  served: Uint8Array,
): { plain: Uint8Array; partial: boolean } {
  const plainSize = refFilePlainSize(pointerSize);
  const none = { plain: new Uint8Array(0), partial: true };
  if (plainSize === null || served.length < REF_FILE.headerBytes) return none;
  const view = new DataView(served.buffer, served.byteOffset, served.length);
  if (
    Buffer.from(served.subarray(0, 8)).toString("latin1") !== REF_FILE.magic ||
    view.getUint16(8, true) !== 1 ||
    view.getUint16(10, true) !== 0 ||
    view.getUint32(12, true) !== REF_FILE.segmentBytes ||
    toHex(served.subarray(16, 32)) !== toHex(refKid(root))
  )
    return none;
  const header = served.subarray(0, REF_FILE.headerBytes);
  const key = refKFile(refKColl(root, collection), served.subarray(32, 64));
  const n = Math.max(1, Math.ceil(plainSize / S));
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    const len = (last ? plainSize - i * S : S) + REF_FILE.tag;
    const off = REF_FILE.headerBytes + i * (S + REF_FILE.tag);
    const seg = served.subarray(off, off + len);
    if (seg.length < len) return { plain: cat(...out), partial: true };
    const nonce = new Uint8Array(12);
    nonce[0] = last ? 1 : 0;
    new DataView(nonce.buffer).setBigUint64(4, BigInt(i), false);
    try {
      const d = createDecipheriv("aes-256-gcm", key, nonce);
      d.setAAD(header);
      d.setAuthTag(seg.subarray(len - REF_FILE.tag));
      out.push(
        new Uint8Array(
          Buffer.concat([
            d.update(seg.subarray(0, len - REF_FILE.tag)),
            d.final(),
          ]),
        ),
      );
    } catch {
      return { plain: cat(...out), partial: true };
    }
  }
  return { plain: cat(...out), partial: false };
}

interface Pointer {
  version: number;
  size: unknown;
  sha256: unknown;
  format: unknown;
}

interface Row {
  collection: string;
  /** The wire id of the record, which keys its files. */
  wire: string;
  id: string;
  version: number;
  value?: unknown;
  hasValue: boolean;
  pointer?: Pointer;
  binding: { sha256: string; size: number; format: string } | null;
}

/** A file the plan will read: what to read and how many plaintext bytes it is planned at. */
interface Planned {
  row: Row;
  file: RefExportFile;
  live: boolean;
  bound: boolean;
  planned: number;
  manifest?: {
    records: { id: Uint8Array; plainLen: number }[];
    plainSha256: Uint8Array;
  };
}

// ── the export ───────────────────────────────────────────────────────────────────────────────

export function refExport(inp: RefExportInput): RefExportResult {
  const e2e = inp.encryption === "e2e";
  const root = e2e ? fromHex(inp.rootHex as string) : null;
  const kn = root === null ? null : refKNames(root);
  const settingSkips: Skipped[] = [];
  const recordSkips: Skipped[] = [];
  const fileSkips: Skipped[] = [];
  const partialSkips: Skipped[] = [];

  // Settings, in the byte order of the name the Worker served.
  const settings = new Map<string, unknown>();
  const settingChanges = inp.changes
    .filter((c) => typeof c["setting"] === "string")
    .sort((a, b) => byBytes(a["setting"] as string, b["setting"] as string));
  for (const c of settingChanges) {
    const wire = c["setting"] as string;
    const got = openSetting(root, kn, wire, c);
    if (got === null || !serialisable(got.name) || !serialisable(got.value))
      settingSkips.push({ kind: "setting", code: "invalid" });
    else settings.set(got.name, got.value);
  }
  const settingsObject = nullObject();
  for (const [k, v] of settings) settingsObject[k] = v;

  // Records, a collection at a time, rows in the byte order of the wire id.
  const recordChanges = inp.changes.filter((c) => Array.isArray(c["record"]));
  const collections = [
    ...new Set(
      recordChanges.map((c) => (c["record"] as string[])[0] as string),
    ),
  ].sort(byBytes);
  const written: Array<{ collection: string; rows: Row[] }> = [];
  /** E2E records with a file and no value, per collection: nothing names the id or binds the file. */
  const fileOnly = new Map<string, number>();
  for (const collection of collections) {
    const rows: Row[] = [];
    const mine = recordChanges
      .filter((c) => (c["record"] as string[])[0] === collection)
      .sort((a, b) =>
        byBytes(
          (a["record"] as string[])[1] as string,
          (b["record"] as string[])[1] as string,
        ),
      );
    for (const c of mine) {
      const wire = (c["record"] as string[])[1] as string;
      const r = openRecord(root, kn, collection, wire, c);
      if (r === "omit") continue;
      if (r === "file-only") {
        fileOnly.set(collection, (fileOnly.get(collection) ?? 0) + 1);
        continue;
      }
      if (
        r === "invalid" ||
        !serialisable(r.id) ||
        !serialisable(r.hasValue ? r.value : null)
      ) {
        recordSkips.push({ kind: "record", code: "invalid", collection });
        continue;
      }
      rows.push(r);
    }
    rows.sort((a, b) => byBytes(a.id, b.id));
    if (rows.length > 0) written.push({ collection, rows });
  }

  // The manifests of every chunked file are fetched and checked before anything else is read.
  const chunkStore = new Map<string, RefChunkedBytes>();
  const chunked = (f: RefExportFile): RefChunkedBytes => {
    const key = `${f.collection}\u0000${f.record}\u0000${f.version}`;
    let c = chunkStore.get(key);
    if (c === undefined) {
      c = refChunkedBytes(
        f.chunked as RefChunkedRecipe,
        f.collection,
        inp.rootHex,
      );
      chunkStore.set(key, c);
    }
    return c;
  };
  let chunkTotal = 0;
  /** The plan size of a candidate, or null when the file cannot be read at all. */
  const validate = (
    f: RefExportFile,
  ): { planned: number; manifest?: Planned["manifest"] } | null => {
    if (!isSize(f.size)) return null;
    if (typeof f.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(f.sha256))
      return null;
    if (f.format === "whole") {
      if (f.stored === undefined) return null;
      if (!e2e) return { planned: f.size };
      const plain = refFilePlainSize(f.size);
      return plain === null ? null : { planned: plain };
    }
    if (f.chunked === undefined) return null;
    const { served } = chunked(f);
    if (
      served.length >
      refPlainToSealed(
        REF_MANIFEST.headerBytes +
          REF_MANIFEST.recordBytes * REF_MANIFEST.maxChunks,
      )
    )
      return null;
    if (sha256(served) !== f.sha256) return null;
    let bytes: Uint8Array;
    if (root === null) bytes = served;
    else {
      const o = refOpenFile(root, f.collection, refKid(root), served);
      if (!o.ok) return null;
      bytes = o.plain;
    }
    const m = refParseManifest(bytes);
    if (!m.ok) return null;
    const stored = e2e
      ? refPlainToSealed(m.manifest.plainSize)
      : m.manifest.plainSize;
    if (stored !== f.size) return null;
    chunkTotal += m.manifest.records.length;
    return {
      planned: m.manifest.plainSize,
      manifest: {
        records: m.manifest.records,
        plainSha256: m.manifest.plainSha256,
      },
    };
  };

  // The plan: every file entry, live first and then the revisions, newest first.
  const planned: Planned[] = [];
  for (const collection of collections) {
    for (let i = 0; i < (fileOnly.get(collection) ?? 0); i++)
      fileSkips.push({ kind: "file", code: "sync-file-invalid", collection });
    const rows = written.find((w) => w.collection === collection)?.rows ?? [];
    for (const row of rows) {
      if (row.pointer === undefined) continue;
      if (e2e && row.binding === null) {
        // A file the sealed value does not name is no readable file there (§13.10.4).
        fileSkips.push({ kind: "file", code: "sync-file-invalid", collection });
        delete row.pointer;
        continue;
      }
      const mine = inp.files.filter(
        (f) => f.collection === row.collection && f.record === row.wire,
      );
      const current = mine.find((f) => f.version === row.pointer?.version);
      const older = mine
        .filter((f) => f !== current)
        .sort((a, b) => b.version - a.version);
      const candidates = [...(current ? [current] : []), ...older];
      const fits = (f: RefExportFile): boolean =>
        row.binding === null
          ? f === current
          : f.sha256 === row.binding.sha256 &&
            f.size === row.binding.size &&
            f.format === row.binding.format;
      const live = candidates.find(fits);
      const mark = (f: RefExportFile, isLive: boolean): void => {
        const v = validate(f);
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
          file: f,
          live: isLive,
          bound: isLive,
          planned: v.planned,
          ...(v.manifest === undefined ? {} : { manifest: v.manifest }),
        });
      };
      if (live === undefined) {
        fileSkips.push({ kind: "file", code: "sync-file-invalid", collection });
        delete row.pointer;
        continue;
      }
      mark(live, true);
      if (inp.includeRevisions)
        for (const f of candidates) if (f !== live) mark(f, false);
    }
  }

  // The bounds, all before the first byte.
  const dir = REF_EXPORT.storeDir;
  const maxEntries = inp.caps?.maxEntries ?? REF_EXPORT.maxEntries;
  const maxBytes = inp.caps?.maxBytes ?? REF_EXPORT.maxBytes;
  const refuse = (): RefExportResult => ({
    ok: false,
    code: "sync-export-too-large",
  });
  const entryCount = 5 + written.length + planned.length;
  if (entryCount > maxEntries || chunkTotal > REF_EXPORT.maxChunks)
    return refuse();
  let fileBytes = 0;
  for (const p of planned) {
    fileBytes += p.planned; // each term and the sum stay safe integers: stop at the cap
    if (fileBytes > maxBytes) return refuse();
  }

  const lineOf = (r: Row, file: unknown): Uint8Array => {
    const o = nullObject();
    o["id"] = r.id;
    o["version"] = r.version;
    if (r.hasValue) o["value"] = r.value;
    if (file !== undefined) o["file"] = file;
    return line(o);
  };
  const liveRows = new Set(planned.filter((p) => p.live).map((p) => p.row));
  let known = bytesOf(REF_EXPORT_README);
  known += line(settingsObject).length;
  const indexKnown = line({
    records: written.map(({ collection, rows }, i) => ({
      entry: `${dir}records/${i}.ndjson`,
      collection,
      count: rows.length,
    })),
  });
  known += indexKnown.length;
  for (const { rows } of written)
    for (const r of rows)
      known +=
        lineOf(r, undefined).length +
        (liveRows.has(r) ? REF_EXPORT.itemReserveBytes : 0);
  // files.json and data.json depend on what the reads find: they count at their bound.
  const reserve = REF_EXPORT.itemReserveBytes;
  known += 2 + planned.length;
  for (const p of planned)
    known += reserve + 6 * (bytesOf(p.row.collection) + bytesOf(p.row.id));
  known += reserve;
  const skippable = [
    ...settingChanges.map(() => ""),
    ...inp.changes
      .filter((c) => Array.isArray(c["record"]))
      .map((c) => (c["record"] as string[])[0] as string),
    ...inp.files.map((f) => f.collection),
  ];
  for (const c of skippable) known += reserve + 6 * bytesOf(c);
  const names = [
    "README.txt",
    `${dir}settings.json`,
    ...written.map((_, i) => `${dir}records/${i}.ndjson`),
    ...planned.map((_, n) => `${dir}files/${n}.bin`),
    `${dir}files.json`,
    `${dir}index.json`,
    "data.json",
  ];
  const overhead =
    names.reduce((a, n) => a + REF_EXPORT.zipEntryBytes + 2 * bytesOf(n), 0) +
    REF_EXPORT.zipEndBytes;
  const planTotal = fileBytes + known + overhead;
  if (planTotal > maxBytes) return refuse();

  // The files, read one at a time, in plan order, at most the planned size each.
  const fileEntries: RefExportEntry[] = [];
  const fileIndex: unknown[] = [];
  const lineFile = new Map<Row, unknown>();
  planned.forEach((p, n) => {
    const entry = `files/${n}.bin`;
    let plain: Uint8Array;
    let partial: boolean;
    if (p.file.format === "chunks") {
      const c = chunked(p.file);
      const m = p.manifest as NonNullable<Planned["manifest"]>;
      const pieces: Uint8Array[] = [];
      partial = false;
      for (const rec of m.records) {
        const obj = c.objects.get(toHex(rec.id));
        const o =
          obj === undefined
            ? null
            : root === null
              ? refOpenServerChunk(rec.id, obj)
              : refOpenChunk(root, p.row.collection, rec.id, obj);
        if (o === null || !o.ok || o.plain.length !== rec.plainLen) {
          partial = true;
          break;
        }
        pieces.push(o.plain);
      }
      plain = cat(...pieces);
      if (!partial && sha256(plain) !== toHex(m.plainSha256)) partial = true;
    } else {
      const { served } = refRecipeBytes(
        p.file.stored as RefStoredRecipe,
        p.row.collection,
        inp.rootHex,
      );
      const read = served.subarray(0, p.file.size as number);
      const storedOk =
        read.length === p.file.size && sha256(read) === p.file.sha256;
      if (root !== null) {
        const o = openFileSegments(
          root,
          p.row.collection,
          p.file.size as number,
          read,
        );
        plain = o.plain;
        partial = o.partial || !storedOk;
      } else {
        plain = read;
        partial = !storedOk;
      }
    }
    if (plain.length > p.planned) throw new Error("read past the plan");
    if (partial)
      partialSkips.push({
        kind: "file",
        code: "sync-file-invalid",
        collection: p.row.collection,
        entry: dir + entry,
        partial: true,
      });
    fileEntries.push({ name: dir + entry, bytes: plain });
    const digest = sha256(plain);
    const item = nullObject();
    item["entry"] = dir + entry;
    item["collection"] = p.row.collection;
    item["id"] = p.row.id;
    item["version"] = p.file.version;
    item["live"] = p.live;
    item["size"] = plain.length;
    item["sha256"] = digest;
    if (partial) {
      item["partial"] = true;
      item["expectedSize"] = p.planned;
    }
    if (e2e && !p.live) item["bound"] = false;
    fileIndex.push(item);
    if (p.live) {
      const f = nullObject();
      f["entry"] = dir + entry;
      f["version"] = p.file.version;
      f["size"] = plain.length;
      f["sha256"] = digest;
      if (partial) {
        f["partial"] = true;
        f["expectedSize"] = p.planned;
      }
      lineFile.set(p.row, f);
    }
  });

  // The record files.
  const recordEntries: RefExportEntry[] = [];
  const indexRecords: unknown[] = [];
  let records = 0;
  written.forEach(({ collection, rows }, i) => {
    const name = `${dir}records/${i}.ndjson`;
    const lines = rows.map((r) => lineOf(r, lineFile.get(r)));
    records += rows.length;
    recordEntries.push({ name, bytes: cat(...lines) });
    indexRecords.push({ entry: name, collection, count: rows.length });
  });

  const data = {
    schema: REF_EXPORT.format,
    source: "device",
    product: inp.product,
    exportedAt: inp.exportedAt,
    encryption: inp.encryption,
    counts: {
      settings: settings.size,
      records,
      files: fileEntries.length,
    },
    unsynced: inp.unsynced,
    skipped: [
      ...settingSkips,
      ...recordSkips,
      ...fileSkips,
      ...partialSkips,
    ].map((s) => ({ ...s })),
  };
  const entries: RefExportEntry[] = [
    { name: "README.txt", bytes: utf8(REF_EXPORT_README) },
    { name: `${dir}settings.json`, bytes: line(settingsObject) },
    ...recordEntries,
    ...fileEntries,
    { name: `${dir}files.json`, bytes: line(fileIndex) },
    { name: `${dir}index.json`, bytes: line({ records: indexRecords }) },
    { name: "data.json", bytes: line(data) },
  ];
  const actual =
    entries.reduce(
      (a, e) =>
        a + e.bytes.length + REF_EXPORT.zipEntryBytes + 2 * bytesOf(e.name),
      0,
    ) + REF_EXPORT.zipEndBytes;
  if (actual > planTotal) throw new Error("the plan undercounted the archive");
  return { ok: true, entries, plan: { total: planTotal, actual } };
}

// ── opening ──────────────────────────────────────────────────────────────────────────────────

const SETTINGS = "$settings";

function openSetting(
  root: Uint8Array | null,
  kn: Uint8Array | null,
  wire: string,
  c: RefExportChange,
): { name: string; value: unknown } | null {
  if (root === null) {
    const members = c["members"];
    if (isObj(members)) return { name: wire, value: members };
    return "value" in c ? { name: wire, value: c["value"] } : null;
  }
  const members = c["members"];
  if (Array.isArray(members)) {
    const value = nullObject();
    for (const m of members) {
      const env =
        isObj(m) && typeof m["ct"] === "string" ? b64urlDecode(m["ct"]) : null;
      if (env === null) return null;
      const r = refOpenValueAnyName(root, SETTINGS, env);
      if (!r.ok) return null;
      const cut = r.name.indexOf("\u0000");
      if (cut < 0 || r.name.slice(0, cut) !== wire) return null;
      const member = r.name.slice(cut + 1);
      if (
        refBlind(kn as Uint8Array, "member", wire, member) !==
        (m as { member: string }).member
      )
        return null;
      value[member] = r.value;
    }
    return { name: wire, value };
  }
  const env = typeof c["ct"] === "string" ? b64urlDecode(c["ct"]) : null;
  if (env === null) return null;
  const r = refOpenValueAnyName(root, SETTINGS, env);
  if (!r.ok) return null;
  if (wire.startsWith("x:")) {
    if (refBlind(kn as Uint8Array, "setting", SETTINGS, r.name) !== wire)
      return null;
    return { name: r.name, value: r.value };
  }
  return r.name === wire ? { name: wire, value: r.value } : null;
}

function pointerOf(c: RefExportChange): Pointer | undefined {
  const f = c["file"];
  return isObj(f) ? (f as unknown as Pointer) : undefined;
}

/** `"omit"`: an empty sealed record whose id is not revealed. `"invalid"`: a cell failed to open. `"file-only"`: an end-to-end record with a file and no value. */
function openRecord(
  root: Uint8Array | null,
  kn: Uint8Array | null,
  collection: string,
  wire: string,
  c: RefExportChange,
): Row | "omit" | "invalid" | "file-only" {
  const base = {
    collection,
    wire,
    version: c["version"] as number,
    pointer: pointerOf(c),
    binding: null as Row["binding"],
  };
  if (root === null) {
    return {
      ...base,
      id: wire,
      hasValue: "value" in c,
      ...("value" in c ? { value: c["value"] } : {}),
    };
  }
  const cells = (
    list: unknown,
    kind: "field" | "element",
  ): Row | "omit" | "invalid" => {
    if (!Array.isArray(list)) return "invalid";
    if (list.length === 0) return "omit";
    let id: string | null = null;
    const fields = nullObject();
    const elements: unknown[] = [];
    const seen = new Set<string>();
    for (const cell of list) {
      const env =
        isObj(cell) && typeof cell["ct"] === "string"
          ? b64urlDecode(cell["ct"])
          : null;
      if (env === null) return "invalid";
      const w: RefRecordWire = {
        kind,
        id: wire,
        name: (cell as Record<string, string>)[kind] as string,
      };
      const r = refOpenRecord(root, collection, w, env);
      if (!r.ok) return "invalid";
      const cut = r.name.indexOf("\u0000");
      // A name the row repeats is not one row's cells: the whole row is invalid.
      const own = r.name.slice(cut + 1);
      if (seen.has(own)) return "invalid";
      seen.add(own);
      id = r.name.slice(0, cut);
      if (kind === "field") fields[r.name.slice(cut + 1)] = r.value;
      else elements.push(r.value);
    }
    return {
      ...base,
      id: id as string,
      hasValue: true,
      value: kind === "field" ? fields : elements,
    };
  };
  if (Array.isArray(c["fields"])) return cells(c["fields"], "field");
  if (Array.isArray(c["elements"])) return cells(c["elements"], "element");
  const env = typeof c["ct"] === "string" ? b64urlDecode(c["ct"]) : null;
  if (env === null) {
    // A file and no value: nothing names the id, nothing binds the file.
    return c["ct"] === undefined && base.pointer !== undefined
      ? "file-only"
      : "invalid";
  }
  const r = refOpenRecord(root, collection, { kind: "value", id: wire }, env);
  if (!r.ok) return "invalid";
  let value = r.value;
  let binding: Row["binding"] = null;
  if (isObj(value) && "$file" in value) {
    const { $file: raw, ...rest } = value as Record<string, unknown>;
    value = rest;
    if (
      isObj(raw) &&
      typeof raw["sha256"] === "string" &&
      /^[0-9a-f]{64}$/.test(raw["sha256"]) &&
      Number.isSafeInteger(raw["size"]) &&
      (raw["size"] as number) > 0 &&
      (raw["format"] === "whole" || raw["format"] === "chunks")
    )
      binding = {
        sha256: raw["sha256"],
        size: raw["size"] as number,
        format: raw["format"],
      };
  }
  return { ...base, id: r.name, hasValue: true, value, binding };
}
