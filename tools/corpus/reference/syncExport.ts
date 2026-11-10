// The independent reference for `sync-vectors.json`'s `exportCases` (WIRE-CONTRACT-V5 §13.12,
// `pkey-sync-export/1`): what `cloudSync.export()` puts in the archive, restated from the spec as
// one whole-buffer function over node:crypto and `reference/syncVectors.ts` (the sealing
// reference). Nothing from client-core. The zip container is not pinned (D4), only the entries:
// their names, their order and their bytes.
//
// Input: what the device holds after a flushed pull with `more: false`: the changes as served
// (sealed in end-to-end mode), the files' stored bytes and the kept revisions' pointers. Output:
// the entry list, or a refusal before the first byte.

import { createDecipheriv, createHash } from "node:crypto";
import {
  REF_FILE,
  cat,
  fromHex,
  refBlind,
  refCanonicalJson,
  refFilePlainSize,
  refKColl,
  refKFile,
  refKNames,
  refKid,
  refOpenRecord,
  refOpenValueAnyName,
  refSealFile,
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
`;

// ── input ────────────────────────────────────────────────────────────────────────────────────

export interface RefFilePointer {
  version: number;
  size: number;
  sha256: string;
  format: "whole" | "chunks";
}

/** How a case's stored bytes are made: a deterministic plaintext, sealed when `saltHex` is given. */
export interface RefStoredRecipe {
  /** The literal label of `refStream(label, length)` (SHA-256(label ‖ u32be(i)) blocks). */
  label: string;
  length: number;
  /** End-to-end: the 32-byte salt of `pkey-sync-file/1`. Absent: server mode, the plaintext. */
  saltHex?: string;
  /** What the transport hands back is only the first `cut` bytes. */
  cut?: number;
  /** What the transport hands back has the low bit of this byte flipped. */
  flipAt?: number;
}

export interface RefExportFile extends RefFilePointer {
  collection: string;
  /** The record id as it is on the wire (blinded in end-to-end mode). */
  record: string;
  stored: RefStoredRecipe;
}

export type RefExportChange = Record<string, unknown>;

export interface RefExportInput {
  product: string;
  subject: string;
  exportedAt: number;
  encryption: "e2e" | "server";
  rootHex?: string;
  includeRevisions: boolean;
  unsynced: number;
  caps?: { maxEntries?: number; maxBytes?: number };
  changes: RefExportChange[];
  files: RefExportFile[];
}

/** The pointer a recipe has before the transport cuts or flips anything: the sealed stream's. */
export function refRecipeBytes(
  recipe: RefStoredRecipe,
  collection: string,
  rootHex: string | undefined,
): { full: Uint8Array; served: Uint8Array } {
  const plain = refStream(recipe.label, recipe.length);
  const full =
    recipe.saltHex === undefined
      ? plain
      : refSealFile(
          fromHex(rootHex as string),
          collection,
          fromHex(recipe.saltHex),
          plain,
        );
  let served: Uint8Array = full;
  if (recipe.flipAt !== undefined) {
    served = Uint8Array.from(full);
    served[recipe.flipAt] = (served[recipe.flipAt] ?? 0) ^ 0x01;
  }
  if (recipe.cut !== undefined) served = served.subarray(0, recipe.cut);
  return { full, served };
}

// ── output ───────────────────────────────────────────────────────────────────────────────────

export interface RefExportEntry {
  name: string;
  bytes: Uint8Array;
}

export type RefExportResult =
  | { ok: true; entries: RefExportEntry[] }
  | { ok: false; code: "sync-export-too-large" };

interface Skipped {
  kind: "setting" | "record" | "file";
  code: "invalid" | "sync-file-invalid";
  collection?: string;
  entry?: string;
  partial?: true;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────

const sha256 = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const byBytes = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const line = (v: unknown): Uint8Array => utf8(refCanonicalJson(v) + "\n");
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const b64urlDecode = (s: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const b = Buffer.from(s, "base64url");
  return b.toString("base64url") === s ? new Uint8Array(b) : null;
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
  const S = REF_FILE.segmentBytes;
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

interface Row {
  collection: string;
  /** The wire id of the record, which keys its files. */
  wire: string;
  id: string;
  version: number;
  value?: unknown;
  hasValue: boolean;
  pointer?: RefFilePointer;
  binding: { sha256: string; size: number; format: string } | null;
}

// ── the export ───────────────────────────────────────────────────────────────────────────────

export function refExport(inp: RefExportInput): RefExportResult {
  const e2e = inp.encryption === "e2e";
  const root = e2e ? fromHex(inp.rootHex as string) : null;
  const kn = root === null ? null : refKNames(root);
  const skipped: Skipped[] = [];

  // Settings, in the byte order of the name the Worker served.
  const settings = new Map<string, unknown>();
  const settingChanges = inp.changes
    .filter((c) => typeof c["setting"] === "string")
    .sort((a, b) => byBytes(a["setting"] as string, b["setting"] as string));
  for (const c of settingChanges) {
    const wire = c["setting"] as string;
    const got = openSetting(root, kn, wire, c);
    if (got === null) skipped.push({ kind: "setting", code: "invalid" });
    else settings.set(got.name, got.value);
  }
  const settingsObject: Record<string, unknown> = {};
  for (const [k, v] of settings) settingsObject[k] = v;

  // Records, a collection at a time, rows in the byte order of the wire id.
  const recordChanges = inp.changes.filter((c) => Array.isArray(c["record"]));
  const collections = [
    ...new Set(
      recordChanges.map((c) => (c["record"] as string[])[0] as string),
    ),
  ].sort(byBytes);
  const written: Array<{ collection: string; rows: Row[] }> = [];
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
        // E2E: a file and no value. No id is revealed and no binding names the file.
        skipped.push({ kind: "file", code: "sync-file-invalid", collection });
        continue;
      }
      if (r === "invalid") {
        skipped.push({ kind: "record", code: "invalid", collection });
        continue;
      }
      if (e2e && r.pointer !== undefined && r.binding === null) {
        // A file the sealed value does not name is no readable file there (§13.10.4).
        skipped.push({ kind: "file", code: "sync-file-invalid", collection });
        delete r.pointer;
      }
      rows.push(r);
    }
    rows.sort((a, b) => byBytes(a.id, b.id));
    if (rows.length > 0) written.push({ collection, rows });
  }

  // The plan: every file entry, live first and then the revisions, newest first.
  interface Planned {
    row: Row;
    file: RefExportFile;
    live: boolean;
  }
  const planned: Planned[] = [];
  for (const { rows } of written)
    for (const row of rows) {
      if (row.pointer === undefined) continue;
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
      if (live === undefined) {
        skipped.push({
          kind: "file",
          code: "sync-file-invalid",
          collection: row.collection,
        });
        delete row.pointer;
        continue;
      }
      planned.push({ row, file: live, live: true });
      if (inp.includeRevisions)
        for (const f of candidates)
          if (f !== live) planned.push({ row, file: f, live: false });
    }

  const maxEntries = inp.caps?.maxEntries ?? REF_EXPORT.maxEntries;
  const maxBytes = inp.caps?.maxBytes ?? REF_EXPORT.maxBytes;
  const entryCount = 5 + written.length + planned.length;
  const fileBytes = planned.reduce(
    (n, p) => n + (e2e ? (refFilePlainSize(p.file.size) ?? 0) : p.file.size),
    0,
  );
  if (entryCount > maxEntries || fileBytes > maxBytes)
    return { ok: false, code: "sync-export-too-large" };

  // The files, read one at a time, in plan order.
  const dir = REF_EXPORT.storeDir;
  const fileEntries: RefExportEntry[] = [];
  const fileIndex: unknown[] = [];
  const lineFile = new Map<Row, unknown>();
  planned.forEach((p, n) => {
    const entry = `files/${n}.bin`;
    const { served } = refRecipeBytes(
      p.file.stored,
      p.row.collection,
      inp.rootHex,
    );
    let plain: Uint8Array;
    let partial: boolean;
    if (root !== null) {
      ({ plain, partial } = openFileSegments(
        root,
        p.row.collection,
        p.file.size,
        served,
      ));
    } else {
      plain = served;
      partial =
        served.length !== p.file.size || sha256(served) !== p.file.sha256;
    }
    if (partial)
      skipped.push({
        kind: "file",
        code: "sync-file-invalid",
        collection: p.row.collection,
        entry: dir + entry,
        partial: true,
      });
    fileEntries.push({ name: dir + entry, bytes: plain });
    const digest = sha256(plain);
    fileIndex.push({
      entry: dir + entry,
      collection: p.row.collection,
      id: p.row.id,
      version: p.file.version,
      live: p.live,
      size: plain.length,
      sha256: digest,
    });
    if (p.live)
      lineFile.set(p.row, {
        entry: dir + entry,
        version: p.file.version,
        size: plain.length,
        sha256: digest,
      });
  });

  // The record files.
  const recordEntries: RefExportEntry[] = [];
  const indexRecords: unknown[] = [];
  let records = 0;
  written.forEach(({ collection, rows }, i) => {
    const name = `${dir}records/${i}.ndjson`;
    const lines = rows.map((r) => {
      const o: Record<string, unknown> = {
        id: r.id,
        version: r.version,
      };
      if (r.hasValue) o["value"] = r.value;
      const f = lineFile.get(r);
      if (f !== undefined) o["file"] = f;
      return line(o);
    });
    records += rows.length;
    recordEntries.push({ name, bytes: cat(...lines) });
    indexRecords.push({ entry: name, collection, count: rows.length });
  });

  const data = {
    schema: REF_EXPORT.format,
    source: "device",
    product: inp.product,
    subject: inp.subject,
    exportedAt: inp.exportedAt,
    encryption: inp.encryption,
    counts: {
      settings: settings.size,
      records,
      files: fileEntries.length,
    },
    unsynced: inp.unsynced,
    skipped: skipped.map((s) => ({ ...s })),
  };
  return {
    ok: true,
    entries: [
      { name: "README.txt", bytes: utf8(REF_EXPORT_README) },
      { name: `${dir}settings.json`, bytes: line(settingsObject) },
      ...recordEntries,
      ...fileEntries,
      { name: `${dir}files.json`, bytes: line(fileIndex) },
      { name: `${dir}index.json`, bytes: line({ records: indexRecords }) },
      { name: "data.json", bytes: line(data) },
    ],
  };
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
    const value: Record<string, unknown> = {};
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

function pointerOf(c: RefExportChange): RefFilePointer | undefined {
  const f = c["file"];
  return isObj(f) ? (f as unknown as RefFilePointer) : undefined;
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
    const fields: Record<string, unknown> = {};
    const elements: unknown[] = [];
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
