// The content corpus (plans/P4-01.md §4.1–§4.5): `conformance/corpus/v2/content/` and
// `conformance/corpus/v2/plan-matrix.json`. A TypeScript port of A7's generator (`gen/gen.py`),
// its planner rows (`gen/planref.py`) and its reference applier
// (`runners/python/pkey_content.py`), reshaped to P4-01's formats: blob refs in the files index,
// packed `pkey-patch/1` descriptors for `files`-scope delta sets, tree payloads and their
// `treeDigest`, the window check before every prefix decode, `packSetId`, variant selection and
// target mapping.
//
// `tools/sign-corpus.ts` calls it, so `pnpm gen:corpus` and `pnpm gen:corpus -- --check` cover
// both corpora. Two modes:
//
//   normal and `--check`  never compress. They read `content/blobs/` (the committed INPUTS,
//                         `refs.json` included), decode with `@polaris-key/zstd-wasm`, hash with
//                         `node:crypto`, and rebuild `content/cases.json` (its `blobs` table
//                         included) and `plan-matrix.json`. A missing blob, a blob the set does not
//                         name, or a stray file under `content/` throws.
//   `--rebuild-content-blobs [--payloads <dir>]`
//                         the only writer of the blobs and of `refs.json`: rebuilds every blob from
//                         the decoded payloads (v1 from its full blob, v2 by the `file` strategy, or
//                         `v1.pck` and `v2.pck` from `--payloads` when seeding) with the zstd CLI,
//                         and refuses unless `zstd -V` reports exactly 1.5.7. Never in the gate: a
//                         rebuild changes hashes, so it is a deliberate PR of its own.
//
// Nothing here imports an SDK or `@polaris-key/client-core` (P3-02's rule): the files-index
// parser, the path rules, `treeDigest`, the appliers, the planner, `selectVariant`, `planTarget`,
// `packSetId` and `frameWindow` are the generator's own. The strict JSON parser, the integer
// token scan and the `content` claims are `sign-corpus.ts`'s reference copies, passed in.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, decodeWithPrefix } from "@polaris-key/zstd-wasm";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = join(
  HERE,
  "..",
  "conformance",
  "corpus",
  "v2",
  "content",
);
export const CONTENT_BLOBS_DIR = join(CONTENT_DIR, "blobs");
export const CONTENT_CASES_NAME = "cases.json";

/** The one zstd CLI version the rebuild mode accepts (plans/P4-01.md §4.2, risk 2). */
const ZSTD_CLI_VERSION = "1.5.7";
const ZSTD_LEVEL = 19;

// Restated literals (the generator imports nothing it checks).
const MAX_FILES_INDEX_BYTES = 33554432;
const MAX_INDEX_FILES = 100000;
const MAX_PACK_PATH_BYTES = 1024;
const PLAN_REQUEST_WEIGHT = 16384;
const FILES_FORMAT = "pkey-files/1";
const PATCH_FORMAT = "pkey-patch/1";
const PATCH_METHOD = "zstd-patch-from";
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const DICT_MAGIC = [0x37, 0xa4, 0x30, 0xec];
const MAX_WIRE_INTEGER = 9007199254740991;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACK_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;

// ── small helpers ─────────────────────────────────────────────────────────────────────────────

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const sha256Hex = (b: Uint8Array | string): string =>
  createHash("sha256")
    .update(typeof b === "string" ? utf8(b) : b)
    .digest("hex");
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);
const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
};
const startsWith = (b: Uint8Array, m: readonly number[]): boolean =>
  b.byteLength >= m.length && m.every((x, i) => b[i] === x);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Compare two strings by their UTF-8 bytes. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  const x = utf8(a);
  const y = utf8(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** Canonical JSON: object keys sorted, arrays in order (A7 §5's comparison). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const sameJson = (a: unknown, b: unknown): boolean =>
  canonical(a) === canonical(b);

function fail(msg: string): never {
  throw new Error(`content corpus: ${msg}`);
}

// ── the reference helpers sign-corpus.ts passes in ─────────────────────────────────────────────

export interface RefJson {
  /** V4 §1.2's strict JSON (duplicate members, depth, number range, lone surrogates). */
  parseStrict(text: string): { ok: true; value: unknown } | { ok: false };
  /** The RFC 6901 pointers of every number token that is not a wire integer (V4 §3). */
  nonWire(text: string): string[];
  /** §2.4's `content` claims over a stamp's top-level `contentApi`, `pins` and `expects`. */
  stampContentClaims(text: string): boolean;
}

// ── frames: the header reader (§2.7 rule 3) ────────────────────────────────────────────────────

/** RFC 8878 §3.1.1's frame header: the window and the content size, or null. */
function frameHeader(
  b: Uint8Array,
): { window: number; contentSize: number | null } | null {
  if (!startsWith(b, ZSTD_MAGIC) || b.byteLength < 5) return null;
  const fhd = b[4]!;
  if (fhd & 0x08) return null;
  const single = (fhd & 0x20) !== 0;
  const dictBytes = [0, 1, 2, 4][fhd & 3]!;
  const fcsFlag = fhd >> 6;
  const fcsBytes = fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag]!;
  const wdBytes = single ? 0 : 1;
  const need = 5 + wdBytes + dictBytes + fcsBytes;
  if (b.byteLength < need) return null;
  let p = 5;
  let window = 0;
  if (!single) {
    const w = b[p++]!;
    const base = 2 ** (10 + (w >> 3));
    window = base + (base / 8) * (w & 7);
  }
  p += dictBytes;
  let fcs: number | null = null;
  if (fcsBytes > 0) {
    let v = 0n;
    for (let i = fcsBytes - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[p + i]!);
    if (fcsBytes === 2) v += 256n;
    fcs = v >= 2n ** 32n ? 2 ** 32 : Number(v);
  }
  if (single) window = fcs!;
  if (window >= 2 ** 32) window = 2 ** 32;
  return { window, contentSize: fcs };
}

/** `frameWindow(bytes)` (plans/P4-01.md §2.7): the frame's window, saturated at 2^32, or null. */
export function refFrameWindow(b: Uint8Array): number | null {
  return frameHeader(b)?.window ?? null;
}

/** ⌈log2(m)⌉ in integers: the bit length of m − 1. */
function ceilLog2(m: number): number {
  let n = 0;
  let v = BigInt(m) - 1n;
  while (v > 0n) {
    n++;
    v >>= 1n;
  }
  return n;
}

/** `windowLogMax = max(10, min(P, ⌈log2(memBytes)⌉))`; the reference is a 64-bit decoder. */
export function refWindowLogMax(memBytes: number, p = 31): number {
  return Math.max(10, Math.min(p, ceilLog2(memBytes)));
}

/** Decode one zstd frame to its declared content size (the rebuild and the loaders). */
function zstdDecode(frame: Uint8Array): Uint8Array {
  const h = frameHeader(frame);
  if (!h || h.contentSize === null) fail("a stored frame has no content size");
  return decode(frame, h.contentSize);
}

// ── Godot PCK directory (rebuild mode only) ────────────────────────────────────────────────────

interface PckEntry {
  path: string;
  offset: number;
  size: number;
}

/** The files of an exporter-like PCK v2–v4, by absolute offset (A7's `pck.py`). */
function readPck(b: Uint8Array): PckEntry[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x43504447) fail("not a PCK");
  const fileBase = Number(dv.getBigUint64(24, true));
  let p = Number(dv.getBigUint64(32, true));
  const count = dv.getUint32(p, true);
  p += 4;
  const out: PckEntry[] = [];
  for (let i = 0; i < count; i++) {
    const sl = dv.getUint32(p, true);
    p += 4;
    let end = p + sl;
    while (end > p && b[end - 1] === 0) end--;
    const path = new TextDecoder().decode(b.subarray(p, end));
    p += sl;
    const offset = fileBase + Number(dv.getBigUint64(p, true));
    const size = Number(dv.getBigUint64(p + 8, true));
    p += 16 + 16 + 4;
    out.push({ path, offset, size });
  }
  return out.sort((a, c) => a.offset - c.offset);
}

// ── formats ──────────────────────────────────────────────────────────────────────────────────

export interface BlobRef {
  sha256: string;
  bytes: number;
  codec: string;
}
export interface IndexEntry {
  path: string;
  offset?: number;
  size: number;
  sha256: string;
  blob: BlobRef;
}
export interface FilesIndex {
  format: string;
  layout: string;
  payload: { size: number; sha256: string };
  files: IndexEntry[];
}
export interface ObjectRef {
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
}
export interface PatchEntry {
  path: string;
  op: "delta" | "blob";
  from?: string;
  to: string;
  size: number;
  codec?: string;
  offset: number;
  length: number;
}
export interface PatchDoc {
  format: string;
  scope: string;
  method: string;
  from: string;
  to: string;
  data: { sha256: string; bytes: number };
  entries: PatchEntry[];
}

/** `treeDigest` (§2.7): SHA-256 of `<sha256> <size> <path>\n` per file, sorted by path bytes. */
export function refTreeDigest(
  files: readonly { path: string; size: number; sha256: string }[],
): string {
  return sha256Hex(
    [...files]
      .sort((a, b) => compareBytes(a.path, b.path))
      .map((f) => `${f.sha256} ${f.size} ${f.path}\n`)
      .join(""),
  );
}

// ── path rules (A7 §3.3 plus `.pkey`) ──────────────────────────────────────────────────────────

const BAD_CHARS = new Set(["\\", ":", "*", "?", '"', "<", ">", "|"]);
const DEVICES = new Set(
  ["con", "prn", "aux", "nul"].concat(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((d) => [`com${d}`, `lpt${d}`]),
  ),
);
const lowerAscii = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function refPathSafe(p: string): boolean {
  const n = utf8(p).length;
  if (n < 1 || n > MAX_PACK_PATH_BYTES) return false;
  for (const c of p) {
    const cp = c.codePointAt(0)!;
    if (cp < 0x20 || cp > 0x7e || BAD_CHARS.has(c)) return false;
  }
  const segs = p.split("/");
  if (lowerAscii(segs[0]!) === ".pkey") return false;
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.endsWith(" ") || s.endsWith(".")) return false;
    if (DEVICES.has(lowerAscii(s.split(".")[0]!))) return false;
  }
  return true;
}

export type PathVerdict =
  | { ok: true }
  | { ok: false; error: string; path: string };

export function refCheckPaths(paths: readonly string[]): PathVerdict {
  const seen = new Set<string>();
  const lower = new Set<string>();
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!refPathSafe(p))
      return { ok: false, error: "files-unsafe-path", path: p };
    if (seen.has(p))
      return { ok: false, error: "files-duplicate-path", path: p };
    const lp = lowerAscii(p);
    if (lower.has(lp))
      return { ok: false, error: "files-case-collision", path: p };
    const parts = lp.split("/");
    const prefixes: string[] = [];
    for (let k = 1; k < parts.length; k++)
      prefixes.push(parts.slice(0, k).join("/"));
    if (dirs.has(lp) || prefixes.some((x) => lower.has(x)))
      return { ok: false, error: "files-path-conflict", path: p };
    seen.add(p);
    lower.add(lp);
    for (const x of prefixes) dirs.add(x);
  }
  return { ok: true };
}

// ── strict-JSON side objects ───────────────────────────────────────────────────────────────────

/** Strict JSON over bytes, with the integer rule's non-wire pointers. */
function strictDoc(
  ref: RefJson,
  bytes: Uint8Array,
): { doc: unknown; nonWire: Set<string> } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) return null;
  const parsed = ref.parseStrict(text);
  if (!parsed.ok) return null;
  return { doc: parsed.value, nonWire: new Set(ref.nonWire(text)) };
}

/** The integer rule at one pointer: a plain integer token from `min` to 2^53 − 1. */
const intAt = (
  v: unknown,
  pointer: string,
  nonWire: Set<string>,
  min = 0,
): v is number =>
  typeof v === "number" &&
  !nonWire.has(pointer) &&
  Number.isInteger(v) &&
  v >= min &&
  v <= MAX_WIRE_INTEGER;

export interface FilesRefMember {
  format: string;
  layout: string;
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
  gaps?: ObjectRef;
}

export type ContentVerdict = { ok: true } & Record<string, unknown>;
export type ContentFailure = { ok: false; error: string; path?: string };

/** The stored object against an object ref, then its decoded bytes (§2.7 step 1). */
function openRef(
  stored: Uint8Array,
  r: { sha256: string; bytes: number; size: number; codec: string },
): Uint8Array | null {
  if (stored.byteLength !== r.bytes || sha256Hex(stored) !== r.sha256)
    return null;
  let out: Uint8Array;
  if (r.codec === "none") out = stored;
  else if (r.codec === "zstd") {
    try {
      out = decode(stored, r.size);
    } catch {
      return null;
    }
  } else return null;
  return out.byteLength === r.size ? out : null;
}

/** `parseFilesIndex(stored, ref, variant)` (§2.7): the index, or the first failure. */
export function refParseFilesIndex(
  ref: RefJson,
  stored: Uint8Array,
  files: FilesRefMember,
  payload: { size: number; sha256: string },
): { ok: true; index: FilesIndex } | ContentFailure {
  const invalid: ContentFailure = { ok: false, error: "files-index-invalid" };
  if (files.size > MAX_FILES_INDEX_BYTES) return invalid;
  const decoded = openRef(stored, files);
  if (decoded === null) return invalid;
  const sd = strictDoc(ref, decoded);
  if (sd === null) return invalid;
  const { doc, nonWire } = sd;
  if (!isObj(doc)) return invalid;
  if (doc.format !== FILES_FORMAT || doc.layout !== files.layout)
    return invalid;
  const p = doc.payload;
  if (!isObj(p) || !intAt(p.size, "/payload/size", nonWire)) return invalid;
  if (typeof p.sha256 !== "string" || !SHA256_RE.test(p.sha256)) return invalid;
  if (p.size !== payload.size || p.sha256 !== payload.sha256) return invalid;
  const list = doc.files;
  if (!Array.isArray(list) || list.length > MAX_INDEX_FILES) return invalid;
  const container = doc.layout === "container";
  for (const [i, e] of list.entries()) {
    const at = `/files/${i}`;
    if (!isObj(e) || typeof e.path !== "string") return invalid;
    if (!intAt(e.size, `${at}/size`, nonWire)) return invalid;
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256))
      return invalid;
    const b = e.blob;
    if (!isObj(b) || typeof b.sha256 !== "string" || !SHA256_RE.test(b.sha256))
      return invalid;
    if (!intAt(b.bytes, `${at}/blob/bytes`, nonWire)) return invalid;
    if (b.codec === "none") {
      if (b.bytes !== e.size || b.sha256 !== e.sha256) return invalid;
    } else if (b.codec !== "zstd") return invalid;
    if (container && !intAt(e.offset, `${at}/offset`, nonWire)) return invalid;
  }
  const entries = list as IndexEntry[];
  const paths = refCheckPaths(entries.map((e) => e.path));
  if (!paths.ok) return paths;
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (container) {
    let end = 0;
    for (const e of entries) {
      if (e.offset! < end) return { ok: false, error: "files-layout-mismatch" };
      end = e.offset! + e.size;
    }
    if (end > p.size) return { ok: false, error: "files-layout-mismatch" };
    if (!files.gaps || p.size - total !== files.gaps.size)
      return { ok: false, error: "files-layout-mismatch" };
  } else if (doc.layout === "tree") {
    for (let i = 1; i < entries.length; i++)
      if (compareBytes(entries[i - 1]!.path, entries[i]!.path) >= 0)
        return invalid;
    if (total !== p.size) return invalid;
    if (refTreeDigest(entries) !== p.sha256) return invalid;
  }
  return { ok: true, index: doc as unknown as FilesIndex };
}

/** `parsePatch` (§2.7): the descriptor of a `files` delta set against the record and target. */
function refParsePatch(
  ref: RefJson,
  stored: Uint8Array,
  delta: Record<string, unknown>,
  targetPayloadSha: string,
  target: FilesIndex,
): PatchDoc | null {
  const pr = delta.patch as ObjectRef;
  const data = delta.data as { sha256: string; bytes: number };
  if (pr.size > MAX_FILES_INDEX_BYTES) return null;
  const decoded = openRef(stored, pr);
  if (decoded === null) return null;
  const sd = strictDoc(ref, decoded);
  if (sd === null) return null;
  const { doc, nonWire } = sd;
  if (!isObj(doc)) return null;
  if (doc.format !== PATCH_FORMAT || doc.scope !== "files") return null;
  if (doc.method !== delta.method || doc.from !== delta.from) return null;
  if (doc.to !== targetPayloadSha) return null;
  const d = doc.data;
  if (!isObj(d) || d.sha256 !== data.sha256) return null;
  if (!intAt(d.bytes, "/data/bytes", nonWire) || d.bytes !== data.bytes)
    return null;
  const list = doc.entries;
  if (!Array.isArray(list) || list.length > MAX_INDEX_FILES) return null;
  const byPath = new Map(target.files.map((f, i) => [f.path, i]));
  const seen = new Set<string>();
  let lastIndex = -1;
  let end = 0;
  for (const [i, e] of list.entries()) {
    const at = `/entries/${i}`;
    if (!isObj(e) || typeof e.path !== "string" || seen.has(e.path))
      return null;
    seen.add(e.path);
    const ti = byPath.get(e.path);
    if (ti === undefined || ti <= lastIndex) return null;
    lastIndex = ti;
    const tf = target.files[ti]!;
    if (e.to !== tf.sha256 || !intAt(e.size, `${at}/size`, nonWire))
      return null;
    if (e.size !== tf.size) return null;
    if (!intAt(e.offset, `${at}/offset`, nonWire)) return null;
    if (!intAt(e.length, `${at}/length`, nonWire)) return null;
    if (e.offset < end) return null;
    end = e.offset + e.length;
    if (e.op === "delta") {
      if (typeof e.from !== "string" || !SHA256_RE.test(e.from)) return null;
    } else if (e.op === "blob") {
      if (e.codec === "none") {
        if (e.length !== e.size) return null;
      } else if (e.codec !== "zstd") return null;
    } else return null;
  }
  if (end > data.bytes) return null;
  return doc as unknown as PatchDoc;
}

// ── the appliers (§2.9) ────────────────────────────────────────────────────────────────────────

export interface InstalledFile {
  path: string;
  sha256: string;
  size: number;
  bytes: Uint8Array;
}
export type Fetch = (sha256: string) => Uint8Array | null;

const err = (error: string, path?: string): ContentFailure =>
  path === undefined ? { ok: false, error } : { ok: false, error, path };

/** One raw-prefix decode behind the window check (§2.7 rule 3). */
function prefixDecode(
  frame: Uint8Array,
  base: Uint8Array,
  size: number,
  memBytes: number,
): Uint8Array | null {
  const wlm = refWindowLogMax(memBytes);
  const w = refFrameWindow(frame);
  if (w === null || w > 2 ** wlm) return null;
  try {
    return decodeWithPrefix(frame, base, size, Math.min(wlm, 31));
  } catch {
    return null;
  }
}

/** `applyFull`. A tree validates its index first, then splits the decoded bytes. */
export function refApplyFull(
  ref: RefJson,
  variant: Record<string, unknown>,
  fetch: Fetch,
): { verdict: ContentVerdict | ContentFailure; out?: Uint8Array } {
  const payload = variant.payload as { size: number; sha256: string };
  const full = variant.full as ObjectRef;
  const files = variant.files as FilesRefMember;
  let index: FilesIndex | null = null;
  if (files.layout === "tree") {
    const r = refParseFilesIndex(
      ref,
      fetch(files.sha256) ?? new Uint8Array(),
      files,
      payload,
    );
    if (!r.ok) return { verdict: r };
    index = r.index;
  }
  if (!["zstd", "none"].includes(full.codec) || full.size !== payload.size)
    return { verdict: err("full-corrupt") };
  const out = openRef(fetch(full.sha256) ?? new Uint8Array(), full);
  if (out === null) return { verdict: err("full-corrupt") };
  if (index === null) {
    if (sha256Hex(out) !== payload.sha256)
      return { verdict: err("full-corrupt") };
    return {
      verdict: { ok: true, sha256: payload.sha256, size: out.byteLength },
      out,
    };
  }
  let pos = 0;
  for (const f of index.files) {
    const part = out.subarray(pos, pos + f.size);
    pos += f.size;
    if (part.byteLength !== f.size || sha256Hex(part) !== f.sha256)
      return { verdict: err("full-corrupt") };
  }
  return {
    verdict: {
      ok: true,
      files: index.files.length,
      bytes: out.byteLength,
      treeDigest: refTreeDigest(index.files),
    },
    out,
  };
}

/** `applyDelta` (`payload` scope). `skipBaseCheck` is the corpus's test-only switch. */
export function refApplyDelta(
  variant: Record<string, unknown>,
  deltaIndex: number,
  base: Uint8Array,
  fetch: Fetch,
  skipBaseCheck = false,
): { verdict: ContentVerdict | ContentFailure; out?: Uint8Array } {
  const payload = variant.payload as { size: number; sha256: string };
  const d = (variant.deltas as Record<string, unknown>[])[deltaIndex]!;
  const a = d.artifact as { sha256: string; bytes: number };
  const art = fetch(a.sha256);
  if (art === null || art.byteLength !== a.bytes || sha256Hex(art) !== a.sha256)
    return { verdict: err("delta-artifact-mismatch") };
  if (!skipBaseCheck && sha256Hex(base) !== d.from)
    return { verdict: err("delta-base-mismatch") };
  const out = prefixDecode(art, base, payload.size, d.memBytes as number);
  if (
    out === null ||
    out.byteLength !== payload.size ||
    sha256Hex(out) !== payload.sha256
  )
    return { verdict: err("delta-apply-failed") };
  return {
    verdict: { ok: true, sha256: payload.sha256, size: out.byteLength },
    out,
  };
}

/** `applyFile`: the `file` strategy (`deltaIndex` null) or a `files`-scope delta set. */
export function refApplyFile(
  ref: RefJson,
  variant: Record<string, unknown>,
  deltaIndex: number | null,
  installed: readonly InstalledFile[],
  fetch: Fetch,
): {
  verdict: ContentVerdict | ContentFailure;
  out?: Uint8Array;
  tree?: Map<string, Uint8Array>;
} {
  const payload = variant.payload as { size: number; sha256: string };
  const files = variant.files as FilesRefMember;
  const r = refParseFilesIndex(
    ref,
    fetch(files.sha256) ?? new Uint8Array(),
    files,
    payload,
  );
  if (!r.ok) return { verdict: r };
  const index = r.index;
  const container = index.layout === "container";
  let gaps: Uint8Array | null = null;
  if (container) {
    const g = files.gaps!;
    gaps = openRef(fetch(g.sha256) ?? new Uint8Array(), g);
    if (gaps === null) return { verdict: err("files-layout-mismatch") };
  }
  let patch: PatchDoc | null = null;
  let data: Uint8Array | null = null;
  let memBytes = 0;
  let downloaded = 0;
  if (deltaIndex !== null) {
    const d = (variant.deltas as Record<string, unknown>[])[deltaIndex]!;
    memBytes = d.memBytes as number;
    const pr = d.patch as ObjectRef;
    patch = refParsePatch(
      ref,
      fetch(pr.sha256) ?? new Uint8Array(),
      d,
      payload.sha256,
      index,
    );
    if (patch === null) return { verdict: err("delta-artifact-mismatch") };
    const dr = d.data as { sha256: string; bytes: number };
    data = fetch(dr.sha256);
    if (
      data === null ||
      data.byteLength !== dr.bytes ||
      sha256Hex(data) !== dr.sha256
    )
      return { verdict: err("delta-artifact-mismatch") };
    downloaded = pr.bytes + dr.bytes;
  }
  const have = new Map<string, InstalledFile>();
  for (const f of installed) if (!have.has(f.sha256)) have.set(f.sha256, f);
  const entries = new Map((patch?.entries ?? []).map((e) => [e.path, e]));
  const counters = { reusedFiles: 0, deltaFiles: 0, blobFiles: 0 };
  const parts: Uint8Array[] = [];
  for (const f of index.files) {
    const reuse = have.get(f.sha256);
    let bytes: Uint8Array;
    if (reuse) {
      bytes = reuse.bytes;
      counters.reusedFiles++;
    } else if (patch !== null) {
      const e = entries.get(f.path);
      if (!e) return { verdict: err("file-source-missing", f.path) };
      const slice = data!.subarray(e.offset, e.offset + e.length);
      if (e.op === "delta") {
        const b = have.get(e.from!);
        if (!b || sha256Hex(b.bytes) !== e.from)
          return { verdict: err("delta-base-mismatch", f.path) };
        const out = prefixDecode(slice, b.bytes, f.size, memBytes);
        if (
          out === null ||
          out.byteLength !== f.size ||
          sha256Hex(out) !== f.sha256
        )
          return { verdict: err("delta-apply-failed", f.path) };
        bytes = out;
        counters.deltaFiles++;
      } else {
        let out: Uint8Array | null = slice;
        if (e.codec === "zstd") {
          try {
            out = decode(slice, f.size);
          } catch {
            out = null;
          }
        }
        if (
          out === null ||
          out.byteLength !== f.size ||
          sha256Hex(out) !== f.sha256
        )
          return { verdict: err("file-corrupt", f.path) };
        bytes = out;
        counters.blobFiles++;
      }
    } else {
      const stored = fetch(f.blob.sha256);
      if (stored === null)
        return { verdict: err("file-source-missing", f.path) };
      const out = openRef(stored, { ...f.blob, size: f.size });
      if (out === null || sha256Hex(out) !== f.sha256)
        return { verdict: err("file-corrupt", f.path) };
      bytes = out;
      counters.blobFiles++;
      downloaded += stored.byteLength;
    }
    parts.push(bytes);
  }
  const tail = { ...counters, downloadedBytes: downloaded };
  if (!container) {
    const tree = new Map<string, Uint8Array>();
    for (const [i, f] of index.files.entries()) {
      const b = parts[i]!;
      if (b.byteLength !== f.size || sha256Hex(b) !== f.sha256)
        return { verdict: err("file-corrupt", f.path) };
      tree.set(f.path, b);
    }
    return {
      verdict: {
        ok: true,
        files: index.files.length,
        bytes: index.files.reduce((a, f) => a + f.size, 0),
        treeDigest: refTreeDigest(index.files),
        ...tail,
      },
      tree,
    };
  }
  const out: Uint8Array[] = [];
  let pos = 0;
  let gp = 0;
  for (const [i, f] of index.files.entries()) {
    const g = f.offset! - pos;
    out.push(gaps!.subarray(gp, gp + g));
    gp += g;
    out.push(parts[i]!);
    pos = f.offset! + f.size;
  }
  out.push(gaps!.subarray(gp));
  const whole = concat(out);
  if (sha256Hex(whole) !== payload.sha256)
    return { verdict: err("payload-hash-mismatch") };
  return {
    verdict: {
      ok: true,
      sha256: payload.sha256,
      size: whole.byteLength,
      ...tail,
    },
    out: whole,
  };
}

// ── the planner (A7 §4.2, with `full.requests`) ────────────────────────────────────────────────

const RANK: Record<string, number> = {
  noop: 0,
  platform: 1,
  delta: 2,
  chunk: 3,
  file: 4,
  full: 5,
};

type Json = unknown;
interface Cand {
  strategy: string;
  delta?: string;
  bytes: number;
  requests: number;
  cost: number;
  peakDisk: number;
  ord: number;
}

export function refPlan(inp: Record<string, Json>): Record<string, Json> {
  const t = inp.target as Record<string, any>;
  const inst = inp.installed as Record<string, any>[];
  const caps = inp.caps as Record<string, any>;
  if (inst.some((i) => i.payloadSha256 === t.payload.sha256))
    return {
      strategy: "noop",
      bytes: 0,
      requests: 0,
      cost: 0,
      peakDisk: 0,
      fallbacks: [],
    };
  if (t.platform) {
    if ((caps.transports ?? []).includes(t.platform.transport))
      return {
        strategy: "platform",
        transport: t.platform.transport,
        fallbacks: [],
      };
    return { error: "plan-transport-unsupported" };
  }
  const strategies = new Set<string>(caps.strategies ?? []);
  const have = new Set(inst.map((i) => i.payloadSha256 as string));
  const cands: Omit<Cand, "cost" | "peakDisk">[] = [];
  if (strategies.has("delta"))
    for (const [k, d] of (t.deltas ?? []).entries() as Iterable<[number, any]>)
      if (
        (caps.patchMethods ?? []).includes(d.method) &&
        have.has(d.from) &&
        d.memBytes <= caps.memBudget
      )
        cands.push({
          strategy: "delta",
          delta: d.id,
          bytes: d.artifacts.reduce((a: number, x: any) => a + x.bytes, 0),
          requests: d.artifacts.length,
          ord: k,
        });
  const seeds = inst.filter((i) => i.chunks).map((i) => i.chunks);
  if (strategies.has("chunk") && t.chunks && seeds.length > 0) {
    const s = new Set<string>();
    for (const sd of seeds) for (const id of sd.ids) s.add(id);
    const seen = new Set<string>();
    let prev: any[] | null = null;
    let runs = 0;
    let n = t.chunks.indexBytes as number;
    for (const r of t.chunks.records as any[][]) {
      const [cid, , cl, bi, bo] = r;
      if (s.has(cid) || seen.has(cid)) continue;
      seen.add(cid);
      n += cl;
      if (prev === null || bi !== prev[3] || bo !== prev[4] + prev[2]) runs++;
      prev = r;
    }
    cands.push({ strategy: "chunk", bytes: n, requests: 1 + runs, ord: 0 });
  }
  const instFiles = inst.filter(
    (i) => i.files !== null && i.files !== undefined,
  );
  if (strategies.has("file") && t.files && instFiles.length > 0) {
    const h = new Set<string>();
    for (const i of instFiles) for (const x of i.files) h.add(x);
    const missing = new Map<string, number>();
    for (const f of t.files.files)
      if (!h.has(f.sha256) && !missing.has(f.sha256))
        missing.set(f.sha256, f.blobBytes);
    let sum = 0;
    for (const v of missing.values()) sum += v;
    cands.push({
      strategy: "file",
      bytes: t.files.indexBytes + t.files.gapsBytes + sum,
      requests: 1 + (t.files.gapsBytes > 0 ? 1 : 0) + missing.size,
      ord: 0,
    });
  }
  if (t.full)
    cands.push({
      strategy: "full",
      bytes: t.full.bytes,
      requests: t.full.requests ?? 1,
      ord: 0,
    });
  if (cands.length === 0) return { error: "plan-no-strategy" };
  const w = (caps.requestWeight ?? PLAN_REQUEST_WEIGHT) as number;
  const all: Cand[] = cands.map((c) => ({
    ...c,
    cost: c.bytes + w * c.requests,
    peakDisk: t.payload.size + c.bytes,
  }));
  const feas = all.filter((c) => c.peakDisk <= caps.freeDisk);
  if (feas.length === 0) return { error: "plan-insufficient-disk" };
  feas.sort(
    (a, b) =>
      a.cost - b.cost || RANK[a.strategy]! - RANK[b.strategy]! || a.ord - b.ord,
  );
  const [chosen, ...rest0] = feas;
  const rest = [
    ...rest0.filter((c) => c.strategy !== "full"),
    ...rest0.filter((c) => c.strategy === "full"),
  ];
  const pub = (c: Cand, full: boolean): Record<string, Json> => {
    const o: Record<string, Json> = { strategy: c.strategy };
    if (c.delta !== undefined) o.delta = c.delta;
    o.bytes = c.bytes;
    o.requests = c.requests;
    o.cost = c.cost;
    if (full) o.peakDisk = c.peakDisk;
    return o;
  };
  return { ...pub(chosen!, true), fallbacks: rest.map((c) => pub(c, false)) };
}

// ── selection and target mapping (§2.9) ────────────────────────────────────────────────────────

const usableCodec = (c: unknown): boolean => c === "zstd" || c === "none";
function readable(files: Record<string, unknown> | undefined): boolean {
  return (
    isObj(files) &&
    files.format === FILES_FORMAT &&
    usableCodec(files.codec) &&
    typeof files.size === "number" &&
    files.size <= MAX_FILES_INDEX_BYTES
  );
}
function usableVariant(v: Record<string, unknown>): boolean {
  const f = v.files as Record<string, unknown>;
  if (f.layout === "container") return true;
  return f.layout === "tree" && readable(f);
}

export function refSelectVariant(
  variants: Record<string, unknown>[],
  prefs: { engine: string | null; axes: Record<string, string[]> },
): { index: number } | { error: string } {
  let best: { index: number; key: number[] } | null = null;
  for (const [i, v] of variants.entries()) {
    if (!usableVariant(v)) continue;
    const req = v.requires as Record<string, unknown> | undefined;
    if (req && has(req, "engine") && req.engine !== prefs.engine) continue;
    const sel = v.variant as Record<string, string>;
    const axes = Object.keys(sel).sort(compareBytes);
    const key: number[] = [];
    let ok = true;
    for (const a of axes) {
      const list = prefs.axes[a];
      const k = list ? list.indexOf(sel[a]!) : -1;
      if (k < 0) {
        ok = false;
        break;
      }
      key.push(k);
    }
    if (!ok) continue;
    const less = (x: number[], y: number[]): boolean => {
      for (let j = 0; j < x.length; j++)
        if (x[j] !== y[j]) return x[j]! < y[j]!;
      return false;
    };
    if (best === null || less(key, best.key)) best = { index: i, key };
  }
  return best === null ? { error: "pack-no-variant" } : { index: best.index };
}

export function refPlanTarget(
  variant: Record<string, unknown>,
  recordSha256: string,
  filesIndex: FilesIndex | null,
): Record<string, Json> {
  const payload = variant.payload;
  if (!usableVariant(variant))
    return {
      release: recordSha256,
      payload,
      full: null,
      platform: null,
      chunks: null,
      files: null,
      deltas: [],
    };
  const files = variant.files as Record<string, any>;
  const container = files.layout === "container";
  const full = variant.full as ObjectRef;
  const p = payload as { size: number };
  const fullT =
    usableCodec(full.codec) && full.size === p.size
      ? container
        ? { bytes: full.bytes, requests: 1 }
        : { bytes: full.bytes + files.bytes, requests: 2 }
      : null;
  const indexOk =
    readable(files) &&
    (!container || (isObj(files.gaps) && usableCodec(files.gaps.codec)));
  const filesT =
    filesIndex !== null && indexOk
      ? {
          indexBytes: files.bytes,
          gapsBytes: container ? files.gaps.bytes : 0,
          files: filesIndex.files.map((f) => ({
            sha256: f.sha256,
            blobBytes: f.blob.bytes,
          })),
        }
      : null;
  const deltas: Record<string, Json>[] = [];
  for (const d of (variant.deltas ?? []) as Record<string, any>[]) {
    if (d.scope === "payload" && container)
      deltas.push({
        id: d.artifact.sha256,
        method: d.method,
        from: d.from,
        memBytes: d.memBytes,
        artifacts: [{ sha256: d.artifact.sha256, bytes: d.artifact.bytes }],
      });
    else if (
      d.scope === "files" &&
      filesT !== null &&
      usableCodec(d.patch.codec)
    )
      deltas.push({
        id: d.patch.sha256,
        method: d.method,
        from: d.from,
        memBytes: d.memBytes,
        artifacts: [
          { sha256: files.sha256, bytes: files.bytes },
          ...(container
            ? [{ sha256: files.gaps.sha256, bytes: files.gaps.bytes }]
            : []),
          { sha256: d.patch.sha256, bytes: d.patch.bytes },
          { sha256: d.data.sha256, bytes: d.data.bytes },
        ],
      });
  }
  return {
    release: recordSha256,
    payload,
    full: fullT,
    platform: null,
    chunks: null,
    files: filesT,
    deltas,
  };
}

/** `packSetId(entries)` (§2.9): null for a bad id, a bad hash or a duplicate pack. */
export function refPackSetId(
  entries: readonly { packId: unknown; releaseSha256: unknown }[],
): string | null {
  const seen = new Set<string>();
  for (const e of entries) {
    if (
      typeof e.packId !== "string" ||
      e.packId === "app" ||
      utf8(e.packId).length > 64 ||
      !PACK_ID_RE.test(e.packId)
    )
      return null;
    if (typeof e.releaseSha256 !== "string" || !SHA256_RE.test(e.releaseSha256))
      return null;
    if (seen.has(e.packId)) return null;
    seen.add(e.packId);
  }
  return sha256Hex(
    [...entries]
      .sort((a, b) => compareBytes(a.packId as string, b.packId as string))
      .map((e) => `${e.packId} ${e.releaseSha256}\n`)
      .join(""),
  );
}

// ── the rebuild mode (the only writer of content/blobs/) ───────────────────────────────────────

function requireZstdCli(): void {
  let out: string;
  try {
    out = execFileSync("zstd", ["-V"], { encoding: "utf8" });
  } catch {
    fail("--rebuild-content-blobs needs the zstd CLI on PATH");
  }
  const m = /v(\d+\.\d+\.\d+)/.exec(out);
  if (!m || m[1] !== ZSTD_CLI_VERSION)
    fail(
      `--rebuild-content-blobs needs zstd ${ZSTD_CLI_VERSION} exactly; \`zstd -V\` says ${out.trim()}`,
    );
}

const json = (o: unknown): Uint8Array => utf8(JSON.stringify(o));

interface Tool {
  zc(b: Uint8Array): Uint8Array;
  pf(base: Uint8Array, target: Uint8Array): Uint8Array;
}
function zstdTool(dir: string): Tool {
  let n = 0;
  const run = (args: string[]): void => {
    execFileSync("zstd", ["-q", "-f", ...args], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  };
  return {
    zc(b) {
      const i = join(dir, `i${n}`);
      const o = join(dir, `o${n++}`);
      writeFileSync(i, b);
      run([`-${ZSTD_LEVEL}`, i, "-o", o]);
      return new Uint8Array(readFileSync(o));
    },
    pf(base, target) {
      const bi = join(dir, `b${n}`);
      const ti = join(dir, `t${n}`);
      const o = join(dir, `p${n++}`);
      writeFileSync(bi, base);
      writeFileSync(ti, target);
      run([`-${ZSTD_LEVEL}`, `--patch-from=${bi}`, ti, "-o", o]);
      return new Uint8Array(readFileSync(o));
    },
  };
}

interface RebuildFile {
  path: string;
  offset: number;
  size: number;
  sha256: string;
  data: Uint8Array;
}

/** The decoded payloads from the committed blobs: v1 from its full blob, v2 by the file strategy. */
function payloadsFromBlobs(ref: RefJson): { v1: Uint8Array; v2: Uint8Array } {
  const set = loadContentSet(ref);
  return { v1: set.v1, v2: set.v2 };
}

export function rebuildContentBlobs(ref: RefJson, payloadsDir?: string): void {
  requireZstdCli();
  const { v1, v2 } = payloadsDir
    ? {
        v1: new Uint8Array(readFileSync(join(payloadsDir, "v1.pck"))),
        v2: new Uint8Array(readFileSync(join(payloadsDir, "v2.pck"))),
      }
    : payloadsFromBlobs(ref);
  const tmp = mkdtempSync(join(tmpdir(), "pkey-content-"));
  try {
    const z = zstdTool(tmp);
    const out = new Map<string, Uint8Array>();
    const refs: Record<string, ObjectRef> = {};
    const put = (name: string, b: Uint8Array): void => {
      if (out.has(name)) fail(`blob written twice: ${name}`);
      out.set(name, b);
    };
    const objRefOf = (
      stored: Uint8Array,
      size: number,
      codec: string,
    ): ObjectRef => ({
      sha256: sha256Hex(stored),
      bytes: stored.byteLength,
      size,
      codec,
    });
    // Every file's stored blob, deduplicated by content hash (§2.7 rule 1: raw when not smaller).
    const blobs = new Map<string, { ref: BlobRef; stored: Uint8Array }>();
    const blobOf = (data: Uint8Array): { ref: BlobRef; stored: Uint8Array } => {
      const h = sha256Hex(data);
      let b = blobs.get(h);
      if (!b) {
        const zz = z.zc(data);
        b =
          zz.byteLength < data.byteLength
            ? {
                ref: {
                  sha256: sha256Hex(zz),
                  bytes: zz.byteLength,
                  codec: "zstd",
                },
                stored: zz,
              }
            : {
                ref: { sha256: h, bytes: data.byteLength, codec: "none" },
                stored: data,
              };
        blobs.set(h, b);
      }
      return b;
    };
    const filesOf = (payload: Uint8Array): RebuildFile[] =>
      readPck(payload).map((e) => {
        const data = payload.subarray(e.offset, e.offset + e.size);
        return { ...e, sha256: sha256Hex(data), data };
      });
    const containerIndex = (
      payload: Uint8Array,
      fs: RebuildFile[],
    ): FilesIndex => ({
      format: FILES_FORMAT,
      layout: "container",
      payload: { size: payload.byteLength, sha256: sha256Hex(payload) },
      files: fs.map((f) => ({
        path: f.path,
        offset: f.offset,
        size: f.size,
        sha256: f.sha256,
        blob: blobOf(f.data).ref,
      })),
    });
    const treeFiles = (fs: RebuildFile[]): RebuildFile[] =>
      [...fs].sort((a, b) => compareBytes(a.path, b.path));
    const treeIndex = (fs: RebuildFile[]): FilesIndex => {
      const sorted = treeFiles(fs);
      return {
        format: FILES_FORMAT,
        layout: "tree",
        payload: {
          size: sorted.reduce((a, f) => a + f.size, 0),
          sha256: refTreeDigest(sorted),
        },
        files: sorted.map((f) => ({
          path: f.path,
          size: f.size,
          sha256: f.sha256,
          blob: blobOf(f.data).ref,
        })),
      };
    };
    const gapsOf = (payload: Uint8Array, fs: RebuildFile[]): Uint8Array => {
      const parts: Uint8Array[] = [];
      let pos = 0;
      for (const f of fs) {
        parts.push(payload.subarray(pos, f.offset));
        pos = f.offset + f.size;
      }
      parts.push(payload.subarray(pos));
      return concat(parts);
    };
    /** A packed `files` set: a frame per changed file, a blob per added one (§2.7). */
    const packSet = (
      base: RebuildFile[],
      target: RebuildFile[],
      from: string,
      to: string,
    ): { doc: PatchDoc; data: Uint8Array; memBytes: number } => {
      const baseHashes = new Set(base.map((f) => f.sha256));
      const baseByPath = new Map(base.map((f) => [f.path, f]));
      const entries: PatchEntry[] = [];
      const parts: Uint8Array[] = [];
      let off = 0;
      let mem = 0;
      for (const f of target) {
        if (baseHashes.has(f.sha256)) continue;
        const b = baseByPath.get(f.path);
        const blob = blobOf(f.data);
        let frame: Uint8Array | null = null;
        if (b && !startsWith(b.data, DICT_MAGIC)) {
          const pfr = z.pf(b.data, f.data);
          if (pfr.byteLength < blob.stored.byteLength) frame = pfr;
        }
        if (frame !== null) {
          entries.push({
            path: f.path,
            op: "delta",
            from: b!.sha256,
            to: f.sha256,
            size: f.size,
            offset: off,
            length: frame.byteLength,
          });
          parts.push(frame);
          off += frame.byteLength;
          mem = Math.max(mem, b!.size + f.size);
        } else {
          entries.push({
            path: f.path,
            op: "blob",
            to: f.sha256,
            size: f.size,
            codec: blob.ref.codec,
            offset: off,
            length: blob.stored.byteLength,
          });
          parts.push(blob.stored);
          off += blob.stored.byteLength;
          mem = Math.max(mem, f.size);
        }
      }
      const data = concat(parts);
      return {
        doc: {
          format: PATCH_FORMAT,
          scope: "files",
          method: PATCH_METHOD,
          from,
          to,
          data: { sha256: sha256Hex(data), bytes: data.byteLength },
          entries,
        },
        data,
        memBytes: mem,
      };
    };

    const f1 = filesOf(v1);
    const f2 = filesOf(v2);
    const c1 = containerIndex(v1, f1);
    const c2 = containerIndex(v2, f2);
    const t1i = treeIndex(f1);
    const t2i = treeIndex(f2);

    // The container pair.
    put("payload/v1.full.zst", z.zc(v1));
    put("files/v1.files.zst", z.zc(json(c1)));
    put("files/v2.files.zst", z.zc(json(c2)));
    put("files/v2.gaps.zst", z.zc(gapsOf(v2, f2)));
    const v1Hashes = new Set(f1.map((f) => f.sha256));
    for (const f of f2) {
      if (v1Hashes.has(f.sha256)) continue;
      const b = blobOf(f.data);
      const name = `files/${b.ref.sha256}`;
      if (!out.has(name)) put(name, b.stored);
    }
    put("deltas/v1-v2.pf.zst", z.pf(v1, v2));
    const cset = packSet(f1, f2, c1.payload.sha256, c2.payload.sha256);
    put("patch/v1-v2.files.zst", z.zc(json(cset.doc)));
    put("patch/v1-v2.files.data", cset.data);

    // The same files as trees (their own data object: §4.3's shared object cannot follow both
    // index orders, §2.7's entry-order rule).
    put("tree/v1.files.zst", z.zc(json(t1i)));
    put("tree/v2.files.zst", z.zc(json(t2i)));
    const tset = packSet(
      treeFiles(f1),
      treeFiles(f2),
      t1i.payload.sha256,
      t2i.payload.sha256,
    );
    put("patch/v1-v2.tree.zst", z.zc(json(tset.doc)));
    put("patch/v1-v2.tree.data", tset.data);

    // t1: the 24 smallest v1 files; t2: t1 with its two smallest files edited.
    const small = [...f1]
      .sort((a, b) => a.size - b.size || compareBytes(a.path, b.path))
      .slice(0, 24);
    const t1Files = treeFiles(small);
    const t1x = treeIndex(t1Files);
    put("tree/t1.files.zst", z.zc(json(t1x)));
    put("tree/t1.full.zst", z.zc(concat(t1Files.map((f) => f.data))));
    const edited = new Set(
      [...small]
        .sort((a, b) => a.size - b.size || compareBytes(a.path, b.path))
        .slice(0, 2)
        .map((f) => f.path),
    );
    const t2Files = t1Files.map((f) => {
      if (!edited.has(f.path)) return f;
      const data = editSmallFile(f.data);
      return { ...f, data, sha256: sha256Hex(data) };
    });
    const t2x = treeIndex(t2Files);
    put("tree/t2.files.zst", z.zc(json(t2x)));
    const sset = packSet(
      t1Files,
      t2Files,
      t1x.payload.sha256,
      t2x.payload.sha256,
    );
    if (sset.doc.entries.filter((e) => e.op === "delta").length !== 2)
      fail("t1 → t2 must be two delta entries");
    put("patch/t1-t2.tree.zst", z.zc(json(sset.doc)));
    put("patch/t1-t2.tree.data", sset.data);

    // A synthetic container index with a zero-size entry sharing its offset with the next.
    put("files/zero-size.files.json", json(zeroSizeIndex()));

    // The four objects the records pin but the set does not ship.
    const ref1 = (name: string, b: Uint8Array): void => {
      const stored = z.zc(b);
      refs[name] = objRefOf(stored, b.byteLength, "zstd");
    };
    ref1("payload/v2.full.zst", v2);
    ref1("files/v1.gaps.zst", gapsOf(v1, f1));
    ref1("tree/v1.full.zst", concat(treeFiles(f1).map((f) => f.data)));
    ref1("tree/v2.full.zst", concat(treeFiles(f2).map((f) => f.data)));
    put(
      "refs.json",
      utf8(
        `${JSON.stringify({ zstd: ZSTD_CLI_VERSION, refs: Object.fromEntries(Object.entries(refs).sort(([a], [b]) => compareBytes(a, b))) }, null, 2)}\n`,
      ),
    );

    rmSync(CONTENT_BLOBS_DIR, { recursive: true, force: true });
    for (const [name, b] of out) {
      const p = join(CONTENT_BLOBS_DIR, ...name.split("/"));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, b);
    }
    console.log(
      `rebuilt ${out.size} content blobs (${[...out.values()].reduce((a, b) => a + b.byteLength, 0)} B) with zstd ${ZSTD_CLI_VERSION}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** t2's edit of a small file: three bytes in the middle, so a `--patch-from` frame stays far
 *  below the file's own blob (§4.3; the window case needs `delta` entries). */
function editSmallFile(b: Uint8Array): Uint8Array {
  const out = b.slice();
  const mid = Math.floor(out.byteLength / 2);
  for (let i = 0; i < 3 && mid + i < out.byteLength; i++)
    out[mid + i] = out[mid + i]! ^ 0x01;
  return out;
}

function zeroSizeIndex(): FilesIndex {
  const a = new Uint8Array(8).fill(0x61);
  const c = new Uint8Array(8).fill(0x63);
  const none = (b: Uint8Array): BlobRef => ({
    sha256: sha256Hex(b),
    bytes: b.byteLength,
    codec: "none",
  });
  return {
    format: FILES_FORMAT,
    layout: "container",
    payload: { size: 48, sha256: sha256Hex("pkey-content-corpus:zero-size") },
    files: [
      {
        path: "a.bin",
        offset: 16,
        size: 8,
        sha256: sha256Hex(a),
        blob: none(a),
      },
      {
        path: "b.bin",
        offset: 24,
        size: 0,
        sha256: sha256Hex(new Uint8Array()),
        blob: none(new Uint8Array()),
      },
      {
        path: "c.bin",
        offset: 24,
        size: 8,
        sha256: sha256Hex(c),
        blob: none(c),
      },
    ],
  };
}

// ── loading the committed set ──────────────────────────────────────────────────────────────────

/** The fixed blob names; `files/<sha256>` blobs follow from v2's index. */
const FIXED_BLOBS = [
  "deltas/v1-v2.pf.zst",
  "files/v1.files.zst",
  "files/v2.files.zst",
  "files/v2.gaps.zst",
  "files/zero-size.files.json",
  "patch/t1-t2.tree.data",
  "patch/t1-t2.tree.zst",
  "patch/v1-v2.files.data",
  "patch/v1-v2.files.zst",
  "patch/v1-v2.tree.data",
  "patch/v1-v2.tree.zst",
  "payload/v1.full.zst",
  "refs.json",
  "tree/t1.files.zst",
  "tree/t1.full.zst",
  "tree/t2.files.zst",
  "tree/v1.files.zst",
  "tree/v2.files.zst",
] as const;
const REFS_NAMES = [
  "files/v1.gaps.zst",
  "payload/v2.full.zst",
  "tree/v1.full.zst",
  "tree/v2.full.zst",
] as const;

function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    const name = prefix ? `${prefix}/${e}` : e;
    if (statSync(p).isDirectory()) out.push(...listFiles(p, name));
    else out.push(name);
  }
  return out;
}

export interface ContentSet {
  /** name → stored bytes, every file under `blobs/`. */
  blobs: Map<string, Uint8Array>;
  /** name → object ref: every shipped zstd or raw object, and `refs.json`'s four entries. */
  objects: Map<string, ObjectRef>;
  refsJson: Record<string, ObjectRef>;
  v1: Uint8Array;
  v2: Uint8Array;
  c1: FilesIndex;
  c2: FilesIndex;
  tree1: FilesIndex;
  tree2: FilesIndex;
  t1: FilesIndex;
  t2: FilesIndex;
  patchC: PatchDoc;
  patchT: PatchDoc;
  patchS: PatchDoc;
  /** v1's files as installed state (from `payload/v1.full.zst` and v1's index). */
  installedV1: InstalledFile[];
  memBytes: { setC: number; setT: number; setS: number };
}

function memOf(doc: PatchDoc, base: Map<string, number>): number {
  let m = 0;
  for (const e of doc.entries)
    m = Math.max(m, e.op === "delta" ? base.get(e.from!)! + e.size : e.size);
  return m;
}

let LOADED: ContentSet | null = null;

/** Read and decode the committed inputs. Throws on a missing or unexpected blob. */
export function loadContentSet(ref: RefJson): ContentSet {
  if (LOADED) return LOADED;
  const names = listFiles(CONTENT_BLOBS_DIR);
  const blobs = new Map<string, Uint8Array>();
  for (const n of names)
    blobs.set(
      n,
      new Uint8Array(readFileSync(join(CONTENT_BLOBS_DIR, ...n.split("/")))),
    );
  const need = (n: string): Uint8Array =>
    blobs.get(n) ??
    fail(`missing blob ${n} (rebuild with --rebuild-content-blobs)`);
  const parseJson = <T>(b: Uint8Array): T =>
    JSON.parse(new TextDecoder().decode(b)) as T;
  const v1 = zstdDecode(need("payload/v1.full.zst"));
  const c1 = parseJson<FilesIndex>(zstdDecode(need("files/v1.files.zst")));
  const c2 = parseJson<FilesIndex>(zstdDecode(need("files/v2.files.zst")));
  const tree1 = parseJson<FilesIndex>(zstdDecode(need("tree/v1.files.zst")));
  const tree2 = parseJson<FilesIndex>(zstdDecode(need("tree/v2.files.zst")));
  const t1 = parseJson<FilesIndex>(zstdDecode(need("tree/t1.files.zst")));
  const t2 = parseJson<FilesIndex>(zstdDecode(need("tree/t2.files.zst")));
  const patchC = parseJson<PatchDoc>(zstdDecode(need("patch/v1-v2.files.zst")));
  const patchT = parseJson<PatchDoc>(zstdDecode(need("patch/v1-v2.tree.zst")));
  const patchS = parseJson<PatchDoc>(zstdDecode(need("patch/t1-t2.tree.zst")));
  const refsDoc = parseJson<{ zstd: string; refs: Record<string, ObjectRef> }>(
    need("refs.json"),
  );
  if (
    refsDoc.zstd !== ZSTD_CLI_VERSION ||
    !sameJson(Object.keys(refsDoc.refs).sort(), [...REFS_NAMES].sort())
  )
    fail("refs.json must hold exactly the four unshipped refs");

  // The expected names: the fixed ones, and one blob per v2 file v1 lacks.
  const v1Hashes = new Set(c1.files.map((f) => f.sha256));
  const expected = new Set<string>(FIXED_BLOBS);
  for (const f of c2.files)
    if (!v1Hashes.has(f.sha256)) expected.add(`files/${f.blob.sha256}`);
  for (const n of expected) need(n);
  for (const n of names)
    if (!expected.has(n))
      fail(`stray: content/blobs/${n} is not part of the content set`);

  const objects = new Map<string, ObjectRef>();
  for (const [n, b] of blobs) {
    // A packed data object is not one frame, and the JSON inputs are raw.
    const raw = n.endsWith(".data") || n.endsWith(".json");
    const h = raw ? null : frameHeader(b);
    objects.set(
      n,
      h && h.contentSize !== null
        ? {
            sha256: sha256Hex(b),
            bytes: b.byteLength,
            size: h.contentSize,
            codec: "zstd",
          }
        : {
            sha256: sha256Hex(b),
            bytes: b.byteLength,
            size: b.byteLength,
            codec: "none",
          },
    );
  }
  for (const [n, r] of Object.entries(refsDoc.refs)) objects.set(n, r);

  const installedV1: InstalledFile[] = c1.files.map((f) => ({
    path: f.path,
    sha256: f.sha256,
    size: f.size,
    bytes: v1.subarray(f.offset!, f.offset! + f.size),
  }));
  // v2 by the file strategy over the committed blobs (a reference rebuild, not a case).
  const byBlob = new Map<string, Uint8Array>();
  for (const f of c2.files) {
    const b = blobs.get(`files/${f.blob.sha256}`);
    if (b) byBlob.set(f.blob.sha256, b);
  }
  byBlob.set(
    objects.get("files/v2.files.zst")!.sha256,
    need("files/v2.files.zst"),
  );
  byBlob.set(
    objects.get("files/v2.gaps.zst")!.sha256,
    need("files/v2.gaps.zst"),
  );
  const gapsRef = objects.get("files/v2.gaps.zst")!;
  const v2Variant = {
    payload: c2.payload,
    files: {
      format: FILES_FORMAT,
      layout: "container",
      ...objects.get("files/v2.files.zst")!,
      gaps: gapsRef,
    },
  };
  const rebuilt = refApplyFile(
    ref,
    v2Variant,
    null,
    installedV1,
    (h) => byBlob.get(h) ?? null,
  );
  if (!rebuilt.verdict.ok || !rebuilt.out)
    fail(`v2 does not rebuild: ${JSON.stringify(rebuilt.verdict)}`);
  const v2 = rebuilt.out;

  const sizeBy = (idx: FilesIndex): Map<string, number> =>
    new Map(idx.files.map((f) => [f.sha256, f.size]));
  LOADED = {
    blobs,
    objects,
    refsJson: refsDoc.refs,
    v1,
    v2,
    c1,
    c2,
    tree1,
    tree2,
    t1,
    t2,
    patchC,
    patchT,
    patchS,
    installedV1,
    memBytes: {
      setC: memOf(patchC, sizeBy(c1)),
      setT: memOf(patchT, sizeBy(tree1)),
      setS: memOf(patchS, sizeBy(t1)),
    },
  };
  return LOADED;
}

/** The object ref of a blob name (shipped or `refs.json`). */
export function contentRef(set: ContentSet, name: string): ObjectRef {
  const r = set.objects.get(name);
  if (!r) fail(`no content object ${name}`);
  return { ...r };
}
export function contentHashBytes(
  set: ContentSet,
  name: string,
): { sha256: string; bytes: number } {
  const r = contentRef(set, name);
  return { sha256: r.sha256, bytes: r.bytes };
}

// ── content/cases.json ─────────────────────────────────────────────────────────────────────────

/** A7 §5's `<ref>`: a blob, optionally decoded (`codec`, `size`), optionally mutated. */
interface BlobCaseRef {
  blob: string;
  codec?: "zstd";
  size?: number;
  mutate?: Mutation[];
}
type Mutation =
  | { op: "truncate"; length: number }
  | { op: "xor"; offset: number; value: number };
type ObjectSource = BlobCaseRef | { text: string };

function mutate(
  b: Uint8Array,
  muts: readonly Mutation[] | undefined,
): Uint8Array {
  if (!muts || muts.length === 0) return b;
  let out = b.slice();
  for (const m of muts) {
    if (m.op === "truncate") out = out.slice(0, m.length);
    else out[m.offset] = out[m.offset]! ^ m.value;
  }
  return out;
}

/** The pack records the cases reuse (their variants), from sign-corpus.ts. */
export interface ContentRecords {
  /** name (`djdl.levels@1.1.0`, …) → `{doc, sha256}` of the signed record. */
  get(name: string): { doc: Record<string, unknown>; sha256: string };
  /** The app twin's `content` (the stamp cases' valid content). */
  appContent: Record<string, unknown>;
}

interface ApplyCase {
  id: string;
  description: string;
  strategy: "full" | "delta" | "file";
  variant: Record<string, unknown>;
  delta?: number;
  installed?: { payload: BlobCaseRef; files: BlobCaseRef };
  objects: Record<string, ObjectSource>;
  skipBaseCheck?: true;
  expect: Record<string, unknown>;
}

export interface BuiltContent {
  /** `content/cases.json`, unformatted. */
  cases: Record<string, unknown>;
  /** `plan-matrix.json`, unformatted. */
  planMatrix: Record<string, unknown>;
  /** `refs.json` entries pinned by a `plan-real-*` row (for the join self-check). */
  planRealPins: Set<string>;
}

/** Run one apply case through the reference, materialising its inputs (A7 §5). */
function runApplyCase(
  ref: RefJson,
  set: ContentSet,
  c: ApplyCase,
): {
  verdict: Record<string, unknown>;
  out?: Uint8Array;
  tree?: Map<string, Uint8Array>;
} {
  const raw = (r: BlobCaseRef): Uint8Array =>
    mutate(
      set.blobs.get(r.blob) ?? fail(`${c.id}: no blob ${r.blob}`),
      r.mutate,
    );
  const materialise = (r: BlobCaseRef): Uint8Array => {
    let b = set.blobs.get(r.blob) ?? fail(`${c.id}: no blob ${r.blob}`);
    if (r.codec === "zstd") b = decode(b, r.size!);
    return mutate(b, r.mutate);
  };
  const store = new Map<string, Uint8Array>();
  for (const [h, src] of Object.entries(c.objects))
    store.set(h, "text" in src ? utf8(src.text) : raw(src));
  const fetch: Fetch = (h) => store.get(h) ?? null;
  let installed: InstalledFile[] = [];
  let base: Uint8Array = new Uint8Array();
  if (c.installed) {
    base = materialise(c.installed.payload);
    const idx = JSON.parse(
      new TextDecoder().decode(materialise(c.installed.files)),
    ) as FilesIndex;
    installed = idx.files.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size: f.size,
      bytes: base.subarray(f.offset!, f.offset! + f.size),
    }));
  }
  if (c.strategy === "full") return refApplyFull(ref, c.variant, fetch);
  if (c.strategy === "delta")
    return refApplyDelta(
      c.variant,
      c.delta!,
      base,
      fetch,
      c.skipBaseCheck === true,
    );
  return refApplyFile(ref, c.variant, c.delta ?? null, installed, fetch);
}

export function buildContentCorpus(
  ref: RefJson,
  set: ContentSet,
  records: ContentRecords,
): BuiltContent {
  const S1 = sha256Hex(set.v1);
  const S2 = sha256Hex(set.v2);
  const N1 = set.v1.byteLength;
  const N2 = set.v2.byteLength;
  const o = (name: string): ObjectRef => contentRef(set, name);
  const blobRef = (
    name: string,
    extra: Partial<BlobCaseRef> = {},
  ): BlobCaseRef => ({
    blob: name,
    ...extra,
  });
  const decoded = (
    name: string,
    extra: Partial<BlobCaseRef> = {},
  ): BlobCaseRef => ({
    blob: name,
    codec: "zstd",
    size: o(name).size,
    ...extra,
  });
  const variantOf = (name: string, i = 0): Record<string, unknown> =>
    clone((records.get(name).doc.variants as Record<string, unknown>[])[i]!);
  const pick = (
    v: Record<string, unknown>,
    keys: string[],
  ): Record<string, unknown> =>
    Object.fromEntries(keys.filter((k) => has(v, k)).map((k) => [k, v[k]]));
  const installedV1 = {
    payload: decoded("payload/v1.full.zst"),
    files: decoded("files/v1.files.zst"),
  };

  const levels1 = variantOf("djdl.levels@1.0.0");
  const levels2 = variantOf("djdl.levels@1.1.0");
  const assets2 = variantOf("djdl.assets@1.1.0");
  const docs1 = variantOf("djdl.docs@1.0.0");
  const fullV = (v: Record<string, unknown>) =>
    pick(v, ["payload", "full", "files"]);
  const deltaV = (v: Record<string, unknown>) => pick(v, ["payload", "deltas"]);
  const fileV = (v: Record<string, unknown>) =>
    pick(v, ["payload", "files", "deltas"]);
  const lv2 = levels2 as Record<string, any>;
  const sha = (n: string): string => o(n).sha256;

  // The v2 file blobs the `file` strategy fetches (v2's files v1 lacks).
  const v1Hashes = new Set(set.c1.files.map((f) => f.sha256));
  const v2New = set.c2.files.filter((f) => !v1Hashes.has(f.sha256));
  const fileObjects: Record<string, ObjectSource> = {
    [sha("files/v2.files.zst")]: blobRef("files/v2.files.zst"),
    [sha("files/v2.gaps.zst")]: blobRef("files/v2.gaps.zst"),
  };
  for (const f of v2New)
    fileObjects[f.blob.sha256] = blobRef(`files/${f.blob.sha256}`);
  const setObjects: Record<string, ObjectSource> = {
    [sha("files/v2.files.zst")]: blobRef("files/v2.files.zst"),
    [sha("files/v2.gaps.zst")]: blobRef("files/v2.gaps.zst"),
    [sha("patch/v1-v2.files.zst")]: blobRef("patch/v1-v2.files.zst"),
    [sha("patch/v1-v2.files.data")]: blobRef("patch/v1-v2.files.data"),
  };

  // Mutation targets: the middle of v1's largest file that v2 reuses (the whole-payload delta
  // certainly copies from it), and of the base of v2's largest per-file delta.
  const v2Hashes = new Set(set.c2.files.map((f) => f.sha256));
  const reused = [...set.c1.files]
    .filter((f) => v2Hashes.has(f.sha256))
    .sort((a, b) => b.size - a.size || compareBytes(a.path, b.path))[0]!;
  const reuseFlip = reused.offset! + Math.floor(reused.size / 2);
  const bigDelta = [...set.patchC.entries]
    .filter((e) => e.op === "delta")
    .sort((a, b) => b.size - a.size || compareBytes(a.path, b.path))[0]!;
  const bigBase = set.c1.files.find((f) => f.sha256 === bigDelta.from)!;
  const baseFlip = bigBase.offset! + Math.floor(bigBase.size / 2);
  const tamperedBlob = v2New[Math.floor(v2New.length / 2)]!;
  // file-source-missing: the packed descriptor without its first blob entry, stored raw.
  const firstBlob = set.patchC.entries.find((e) => e.op === "blob")!;
  const missingDoc: PatchDoc = {
    ...set.patchC,
    entries: set.patchC.entries.filter((e) => e !== firstBlob),
  };
  const missingText = JSON.stringify(missingDoc);
  const missingRef: ObjectRef = {
    sha256: sha256Hex(missingText),
    bytes: utf8(missingText).byteLength,
    size: utf8(missingText).byteLength,
    codec: "none",
  };
  const missingVariant = clone(fileV(levels2)) as Record<string, any>;
  missingVariant.deltas[1].patch = missingRef;
  const overMem = clone(deltaV(levels2)) as Record<string, any>;
  overMem.deltas[0].memBytes = 4194304;
  // The small-window tree: t1 → t2 (§4.4), a variant no record carries.
  const smallVariant = {
    payload: set.t2.payload,
    files: { format: FILES_FORMAT, layout: "tree", ...o("tree/t2.files.zst") },
    deltas: [
      {
        method: PATCH_METHOD,
        scope: "files",
        from: set.t1.payload.sha256,
        memBytes: set.memBytes.setS,
        patch: o("patch/t1-t2.tree.zst"),
        data: {
          sha256: sha("patch/t1-t2.tree.data"),
          bytes: o("patch/t1-t2.tree.data").bytes,
        },
      },
    ],
  };
  if (set.memBytes.setS >= 512) fail("t1 → t2's memBytes must stay under 512");

  const applyCases: ApplyCase[] = [
    {
      id: "full-v1",
      description:
        "First install of a container: the full object decodes to the payload.",
      strategy: "full",
      variant: fullV(levels1),
      objects: { [sha("payload/v1.full.zst")]: blobRef("payload/v1.full.zst") },
      expect: {},
    },
    {
      id: "full-v1-tampered",
      description:
        "One byte flipped in the middle of the stored full object: its SHA-256 differs from the ref, refused before decoding.",
      strategy: "full",
      variant: fullV(levels1),
      objects: {
        [sha("payload/v1.full.zst")]: blobRef("payload/v1.full.zst", {
          mutate: [
            {
              op: "xor",
              offset: Math.floor(o("payload/v1.full.zst").bytes / 2),
              value: 1,
            },
          ],
        }),
      },
      expect: {},
    },
    {
      id: "full-tree-t1",
      description:
        "First install of a tree: the index validates, then the full object splits by entry sizes in index order and every file's SHA-256 holds.",
      strategy: "full",
      variant: fullV(docs1),
      objects: {
        [sha("tree/t1.full.zst")]: blobRef("tree/t1.full.zst"),
        [sha("tree/t1.files.zst")]: blobRef("tree/t1.files.zst"),
      },
      expect: {},
    },
    {
      id: "full-tree-index-tampered",
      description:
        "As full-tree-t1 with one byte of the stored index flipped: a tree validates its index first.",
      strategy: "full",
      variant: fullV(docs1),
      objects: {
        [sha("tree/t1.full.zst")]: blobRef("tree/t1.full.zst"),
        [sha("tree/t1.files.zst")]: blobRef("tree/t1.files.zst", {
          mutate: [{ op: "xor", offset: 10, value: 1 }],
        }),
      },
      expect: {},
    },
    {
      id: "delta-whole-v1-to-v2",
      description:
        "The whole-payload `--patch-from` frame over the installed v1 payload.",
      strategy: "delta",
      variant: deltaV(levels2),
      delta: 0,
      installed: installedV1,
      objects: { [sha("deltas/v1-v2.pf.zst")]: blobRef("deltas/v1-v2.pf.zst") },
      expect: {},
    },
    {
      id: "delta-whole-wrong-base",
      description:
        "The installed base has one flipped byte inside a file v2 reuses: the base hash check refuses it before decoding.",
      strategy: "delta",
      variant: deltaV(levels2),
      delta: 0,
      installed: {
        ...installedV1,
        payload: decoded("payload/v1.full.zst", {
          mutate: [{ op: "xor", offset: reuseFlip, value: 1 }],
        }),
      },
      objects: { [sha("deltas/v1-v2.pf.zst")]: blobRef("deltas/v1-v2.pf.zst") },
      expect: {},
    },
    {
      id: "delta-whole-wrong-base-unchecked",
      description:
        "As delta-whole-wrong-base with the base check skipped (a test-only switch): the decoder's checksum or the output hash must fail.",
      strategy: "delta",
      variant: deltaV(levels2),
      delta: 0,
      installed: {
        ...installedV1,
        payload: decoded("payload/v1.full.zst", {
          mutate: [{ op: "xor", offset: reuseFlip, value: 1 }],
        }),
      },
      objects: { [sha("deltas/v1-v2.pf.zst")]: blobRef("deltas/v1-v2.pf.zst") },
      skipBaseCheck: true,
      expect: {},
    },
    {
      id: "delta-whole-artifact-tampered",
      description: "The stored artifact does not match its pinned SHA-256.",
      strategy: "delta",
      variant: deltaV(levels2),
      delta: 0,
      installed: installedV1,
      objects: {
        [sha("deltas/v1-v2.pf.zst")]: blobRef("deltas/v1-v2.pf.zst", {
          mutate: [{ op: "xor", offset: 100, value: 1 }],
        }),
      },
      expect: {},
    },
    {
      id: "delta-whole-window-over-mem-bytes",
      description: `\`memBytes\` 4,194,304 makes \`windowLogMax\` exactly 22 (the bit length of \`memBytes\` would make it 23). The frame's window, its ${N2.toLocaleString("en-US")}-byte content size, is above 2^22, so every SDK refuses it before decoding, whichever decoder it uses.`,
      strategy: "delta",
      variant: overMem,
      delta: 0,
      installed: installedV1,
      objects: { [sha("deltas/v1-v2.pf.zst")]: blobRef("deltas/v1-v2.pf.zst") },
      expect: {},
    },
    {
      id: "file-v1-to-v2",
      description:
        "The `file` strategy: reuse installed files by hash, fetch each other file's own blob by its index ref, fill the gaps.",
      strategy: "file",
      variant: fileV(levels2),
      installed: installedV1,
      objects: fileObjects,
      expect: {},
    },
    {
      id: "file-delta-v1-to-v2",
      description:
        "The packed `files` set: a `--patch-from` frame per changed file and a blob per added one, from one descriptor and one data object.",
      strategy: "file",
      variant: fileV(levels2),
      delta: 1,
      installed: installedV1,
      objects: setObjects,
      expect: {},
    },
    {
      id: "file-delta-tree",
      description:
        "The same files as a tree (no offsets, no gaps): every file verified, reused ones included, and the tree digest reported.",
      strategy: "file",
      variant: fileV(assets2),
      delta: 0,
      installed: installedV1,
      objects: {
        [sha("tree/v2.files.zst")]: blobRef("tree/v2.files.zst"),
        [sha("patch/v1-v2.tree.zst")]: blobRef("patch/v1-v2.tree.zst"),
        [sha("patch/v1-v2.tree.data")]: blobRef("patch/v1-v2.tree.data"),
      },
      expect: {},
    },
    {
      id: "file-delta-tree-small-window",
      description:
        "t1 → t2, two files under 256 bytes edited: `memBytes` under 512, so `windowLogMax` is 10 and never lower. An SDK that passes the limit to its decoder without the floor fails here.",
      strategy: "file",
      variant: smallVariant,
      delta: 0,
      installed: installedV1,
      objects: {
        [sha("tree/t2.files.zst")]: blobRef("tree/t2.files.zst"),
        [sha("patch/t1-t2.tree.zst")]: blobRef("patch/t1-t2.tree.zst"),
        [sha("patch/t1-t2.tree.data")]: blobRef("patch/t1-t2.tree.data"),
      },
      expect: {},
    },
    {
      id: "file-delta-wrong-base",
      description:
        "The installed copy of a changed file has a flipped byte: its base hash check fails before its frame is decoded.",
      strategy: "file",
      variant: fileV(levels2),
      delta: 1,
      installed: {
        ...installedV1,
        payload: decoded("payload/v1.full.zst", {
          mutate: [{ op: "xor", offset: baseFlip, value: 1 }],
        }),
      },
      objects: setObjects,
      expect: {},
    },
    {
      id: "file-delta-data-tampered",
      description:
        "The packed data object does not match the delta's `data` ref.",
      strategy: "file",
      variant: fileV(levels2),
      delta: 1,
      installed: installedV1,
      objects: {
        ...setObjects,
        [sha("patch/v1-v2.files.data")]: blobRef("patch/v1-v2.files.data", {
          mutate: [{ op: "xor", offset: 1000, value: 1 }],
        }),
      },
      expect: {},
    },
    {
      id: "file-blob-tampered",
      description:
        "One fetched file blob has a flipped byte: it no longer matches its index ref.",
      strategy: "file",
      variant: fileV(levels2),
      installed: installedV1,
      objects: {
        ...fileObjects,
        [tamperedBlob.blob.sha256]: blobRef(
          `files/${tamperedBlob.blob.sha256}`,
          {
            mutate: [
              {
                op: "xor",
                offset: Math.floor(tamperedBlob.blob.bytes / 2),
                value: 1,
              },
            ],
          },
        ),
      },
      expect: {},
    },
    {
      id: "file-index-tampered",
      description: "The stored target index has a flipped byte.",
      strategy: "file",
      variant: fileV(levels2),
      installed: installedV1,
      objects: {
        ...fileObjects,
        [sha("files/v2.files.zst")]: blobRef("files/v2.files.zst", {
          mutate: [{ op: "xor", offset: 200, value: 1 }],
        }),
      },
      expect: {},
    },
    {
      id: "file-source-missing",
      description:
        "A descriptor (stored raw, `codec: none`) that lacks the first added file's entry: that file has no source.",
      strategy: "file",
      variant: missingVariant,
      delta: 1,
      installed: installedV1,
      objects: {
        ...setObjects,
        [missingRef.sha256]: { text: missingText },
      },
      expect: {},
    },
    {
      id: "file-gaps-short",
      description:
        "The stored gaps object is one byte short: its ref fails, which is a layout failure.",
      strategy: "file",
      variant: fileV(levels2),
      delta: 1,
      installed: installedV1,
      objects: {
        ...setObjects,
        [sha("files/v2.gaps.zst")]: blobRef("files/v2.gaps.zst", {
          mutate: [
            { op: "truncate", length: o("files/v2.gaps.zst").bytes - 1 },
          ],
        }),
      },
      expect: {},
    },
  ];
  void lv2;
  const outputs = new Map<string, Uint8Array | Map<string, Uint8Array>>();
  for (const c of applyCases) {
    const r = runApplyCase(ref, set, c);
    c.expect = r.verdict;
    if (r.out) outputs.set(c.id, r.out);
    if (r.tree) outputs.set(c.id, r.tree);
  }

  // ── self-checks over the apply verdicts ──
  const wantOk = new Set([
    "full-v1",
    "full-tree-t1",
    "delta-whole-v1-to-v2",
    "file-v1-to-v2",
    "file-delta-v1-to-v2",
    "file-delta-tree",
    "file-delta-tree-small-window",
  ]);
  const wantErr: Record<string, [string, boolean]> = {
    "full-v1-tampered": ["full-corrupt", false],
    "full-tree-index-tampered": ["files-index-invalid", false],
    "delta-whole-wrong-base": ["delta-base-mismatch", false],
    "delta-whole-wrong-base-unchecked": ["delta-apply-failed", false],
    "delta-whole-artifact-tampered": ["delta-artifact-mismatch", false],
    "delta-whole-window-over-mem-bytes": ["delta-apply-failed", false],
    "file-delta-wrong-base": ["delta-base-mismatch", true],
    "file-delta-data-tampered": ["delta-artifact-mismatch", false],
    "file-blob-tampered": ["file-corrupt", true],
    "file-index-tampered": ["files-index-invalid", false],
    "file-source-missing": ["file-source-missing", true],
    "file-gaps-short": ["files-layout-mismatch", false],
  };
  if (applyCases.length !== 19) fail(`applyCases: ${applyCases.length} != 19`);
  for (const c of applyCases) {
    const v = c.expect;
    if (wantOk.has(c.id)) {
      if (v.ok !== true) fail(`${c.id} must be ok: ${JSON.stringify(v)}`);
      continue;
    }
    const w = wantErr[c.id] ?? fail(`${c.id} has no expectation`);
    if (v.ok !== false || v.error !== w[0] || has(v, "path") !== w[1])
      fail(`${c.id} must fail with ${w[0]}: ${JSON.stringify(v)}`);
  }
  const eq = (a: Uint8Array, b: Uint8Array): boolean =>
    a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
  const outOf = (id: string): Uint8Array => outputs.get(id) as Uint8Array;
  for (const id of [
    "delta-whole-v1-to-v2",
    "file-v1-to-v2",
    "file-delta-v1-to-v2",
  ])
    if (
      !eq(outOf(id), set.v2) ||
      sha256Hex(outOf(id)) !== set.c2.payload.sha256
    )
      fail(`${id} does not rebuild v2 byte for byte`);
  if (!eq(outOf("full-v1"), set.v1)) fail("full-v1 does not rebuild v1");
  const ft = applyCases.find((c) => c.id === "file-delta-tree")!.expect;
  if (ft.treeDigest !== set.tree2.payload.sha256)
    fail("file-delta-tree's digest is not v2's");
  const fs = applyCases.find(
    (c) => c.id === "file-delta-tree-small-window",
  )!.expect;
  if (fs.treeDigest !== set.t2.payload.sha256 || fs.deltaFiles !== 2)
    fail("file-delta-tree-small-window must rebuild t2 with two delta files");
  const f1 = applyCases.find((c) => c.id === "full-tree-t1")!.expect;
  if (f1.treeDigest !== set.t1.payload.sha256)
    fail("full-tree-t1's digest is not t1's");
  if (refWindowLogMax(set.memBytes.setS) !== 10)
    fail("t1 → t2 must give windowLogMax 10");
  if (ceilLog2(4194304) !== 22 || refWindowLogMax(4194304) !== 22)
    fail("4,194,304 must give windowLogMax 22");
  const pfWindow = refFrameWindow(set.blobs.get("deltas/v1-v2.pf.zst")!);
  if (pfWindow === null || pfWindow <= 2 ** 22 || pfWindow > 2 ** 23)
    fail(`deltas/v1-v2.pf.zst's window must be in (2^22, 2^23]: ${pfWindow}`);

  // ── pathCases (A7's 17 and `.pkey`) ──
  const pathRows: [string, string, string[], string | null, string?][] = [
    [
      "paths-ok",
      "Ordinary portable paths, spaces and `@`/`+` included.",
      [
        "assets/a.json",
        "assets/b.json",
        ".godot/imported/x.ctex",
        "a b/c@2x+1.png",
      ],
      null,
    ],
    [
      "paths-dotdot",
      "A `..` segment.",
      ["assets/../../evil"],
      "files-unsafe-path",
    ],
    [
      "paths-dot-segment",
      "A `.` segment.",
      ["assets/./a"],
      "files-unsafe-path",
    ],
    [
      "paths-absolute",
      "A leading `/` (an empty first segment).",
      ["/etc/passwd"],
      "files-unsafe-path",
    ],
    [
      "paths-backslash",
      "A backslash.",
      ["assets\\a.json"],
      "files-unsafe-path",
    ],
    ["paths-drive", "A drive letter (`:`).", ["C:/x"], "files-unsafe-path"],
    [
      "paths-empty-segment",
      "A doubled `/`.",
      ["assets//a"],
      "files-unsafe-path",
    ],
    [
      "paths-trailing-slash",
      "A trailing `/`.",
      ["assets/"],
      "files-unsafe-path",
    ],
    [
      "paths-control-char",
      "U+001F (A7 §5: never U+0000 in a JSON string).",
      ["a\u001fb"],
      "files-unsafe-path",
    ],
    [
      "paths-non-ascii",
      "A non-ASCII character.",
      ["assets/caf\u00e9.json"],
      "files-unsafe-path",
    ],
    [
      "paths-reserved-char",
      "A reserved character (`:`) inside a segment.",
      ["assets/a:b"],
      "files-unsafe-path",
    ],
    [
      "paths-duplicate",
      "An exact duplicate: the later path is reported.",
      ["a/b", "a/b"],
      "files-duplicate-path",
    ],
    [
      "paths-case-collision",
      "An ASCII-case-insensitive duplicate.",
      ["Assets/A.json", "assets/a.json"],
      "files-case-collision",
    ],
    [
      "paths-file-dir-conflict",
      "A file that is a directory of a later path, case-insensitively.",
      ["a/b", "A/B/c"],
      "files-path-conflict",
    ],
    [
      "paths-trailing-dot",
      "A segment ending in `.`.",
      ["assets/a./b"],
      "files-unsafe-path",
    ],
    [
      "paths-windows-device",
      "A Windows device name before the first `.`.",
      ["assets/aux.json"],
      "files-unsafe-path",
    ],
    [
      "paths-too-long",
      "1,025 bytes, one past the limit.",
      ["a".repeat(1025)],
      "files-unsafe-path",
    ],
    [
      "paths-reserved-pkey-dir",
      "A first segment `.pkey` in any case: a tree's marker lives there.",
      ["assets/a.json", ".PKey/pack.json"],
      "files-unsafe-path",
      ".PKey/pack.json",
    ],
  ];
  const pathCases = pathRows.map(([id, description, paths, error, at]) => {
    const expect: PathVerdict =
      error === null
        ? { ok: true }
        : { ok: false, error, path: at ?? paths[paths.length - 1]! };
    const got = refCheckPaths(paths);
    if (!sameJson(got, expect)) fail(`${id}: ${JSON.stringify(got)}`);
    if (paths.some((p) => p.includes("\u0000"))) fail(`${id}: U+0000`);
    return { id, description, paths, expect };
  });

  // ── filesIndexCases ──
  const textRef = (
    text: string,
    extra: Record<string, unknown>,
  ): FilesRefMember => {
    const n = utf8(text).byteLength;
    return {
      format: FILES_FORMAT,
      layout: "container",
      sha256: sha256Hex(text),
      bytes: n,
      size: n,
      codec: "none",
      ...extra,
    } as FilesRefMember;
  };
  const zs = set.blobs.get("files/zero-size.files.json")!;
  const zsDoc = JSON.parse(new TextDecoder().decode(zs)) as FilesIndex;
  const zsGapsBytes = new Uint8Array(
    zsDoc.payload.size - zsDoc.files.reduce((a, f) => a + f.size, 0),
  );
  const zsGaps: ObjectRef = {
    sha256: sha256Hex(zsGapsBytes),
    bytes: zsGapsBytes.byteLength,
    size: zsGapsBytes.byteLength,
    codec: "none",
  };
  const synth = (
    mut: (d: Record<string, any>) => void,
  ): { text: string; doc: Record<string, any> } => {
    const d = clone(zsDoc) as Record<string, any>;
    mut(d);
    return { text: JSON.stringify(d), doc: d };
  };
  const synthCase = (
    id: string,
    description: string,
    text: string,
    payload: { size: number; sha256: string },
    extra: Record<string, unknown> = { gaps: zsGaps },
  ) => ({
    id,
    description,
    stored: { text },
    files: textRef(text, extra),
    payload,
  });
  const treeOf = (
    files: { path: string; size: number; data: Uint8Array }[],
  ): FilesIndex => {
    const fs = files.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: sha256Hex(f.data),
      blob: { sha256: sha256Hex(f.data), bytes: f.size, codec: "none" },
    }));
    return {
      format: FILES_FORMAT,
      layout: "tree",
      payload: {
        size: fs.reduce((a, f) => a + f.size, 0),
        sha256: refTreeDigest(fs),
      },
      files: fs,
    };
  };
  const tf = [
    { path: "a/one.txt", size: 3, data: utf8("one") },
    { path: "b/two.txt", size: 3, data: utf8("two") },
  ];
  const treeOk = treeOf(tf);
  const treeUnsorted = {
    ...treeOk,
    files: [treeOk.files[1]!, treeOk.files[0]!],
  };
  const treeBadDigest = {
    ...treeOk,
    payload: { ...treeOk.payload, sha256: sha256Hex("not the digest") },
  };
  const v2Files: FilesRefMember = {
    format: FILES_FORMAT,
    layout: "container",
    ...o("files/v2.files.zst"),
    gaps: o("files/v2.gaps.zst"),
  };
  const treeFiles2: FilesRefMember = {
    format: FILES_FORMAT,
    layout: "tree",
    ...o("tree/v2.files.zst"),
  };
  const offsetNear = JSON.stringify(zsDoc).replace(
    '"offset":16',
    '"offset":16.00000000000000001',
  );
  if (offsetNear === JSON.stringify(zsDoc))
    fail("offset-near-integer did not substitute");
  const dupMember = JSON.stringify(zsDoc).replace(
    '{"format":"pkey-files/1"',
    '{"format":"pkey-files/1","format":"pkey-files/1"',
  );
  const filesIndexCases: Record<string, unknown>[] = [
    {
      id: "files-index-valid-container",
      description: "v2's container index with its blob refs.",
      stored: blobRef("files/v2.files.zst"),
      files: v2Files,
      payload: set.c2.payload,
    },
    {
      id: "files-index-valid-tree",
      description:
        "v2's files as a tree index: strictly ascending paths, sizes summing to the payload, the tree digest as its SHA-256.",
      stored: blobRef("tree/v2.files.zst"),
      files: treeFiles2,
      payload: set.tree2.payload,
    },
    {
      id: "files-index-valid-zero-size-entry",
      description:
        "A raw (`codec: none`) container index whose zero-size entry shares its offset with the next.",
      stored: blobRef("files/zero-size.files.json"),
      files: { ...textRef(new TextDecoder().decode(zs), { gaps: zsGaps }) },
      payload: zsDoc.payload,
    },
    synthCase(
      "files-index-not-json",
      "The decoded bytes are not JSON.",
      '{"format":"pkey-files/1",',
      zsDoc.payload,
    ),
    synthCase(
      "files-index-duplicate-member",
      "A duplicate member name (strict JSON).",
      dupMember,
      zsDoc.payload,
    ),
    synthCase(
      "files-index-format-unknown",
      "`format` is `pkey-files/2`.",
      synth((d) => {
        d.format = "pkey-files/2";
      }).text,
      zsDoc.payload,
    ),
    {
      id: "files-index-payload-mismatch",
      description: "The index's `payload` differs from the variant's.",
      stored: blobRef("files/v2.files.zst"),
      files: v2Files,
      payload: { ...set.c2.payload, size: set.c2.payload.size + 1 },
    },
    {
      id: "files-index-size-mismatch",
      description: "The ref's `size` is one byte short of the decoded length.",
      stored: blobRef("files/v2.files.zst"),
      files: { ...v2Files, size: v2Files.size - 1 },
      payload: set.c2.payload,
    },
    {
      id: "files-index-over-max-size",
      description:
        "`ref.size` is MAX_FILES_INDEX_BYTES + 1: refused before anything is decoded.",
      stored: blobRef("files/v2.files.zst"),
      files: { ...v2Files, size: MAX_FILES_INDEX_BYTES + 1 },
      payload: set.c2.payload,
    },
    synthCase(
      "files-index-offset-near-integer",
      "The `offset` token `16.00000000000000001` denotes no integer (the integer rule).",
      offsetNear,
      zsDoc.payload,
    ),
    synthCase(
      "files-index-blob-none-size-mismatch",
      "A `codec: none` blob whose `bytes` differ from the entry's `size`.",
      synth((d) => {
        d.files[0].blob.bytes = 9;
      }).text,
      zsDoc.payload,
    ),
    synthCase(
      "files-index-blob-codec-unknown",
      "A blob codec other than `zstd` or `none` is a parse failure inside an index.",
      synth((d) => {
        d.files[0].blob.codec = "lz4";
      }).text,
      zsDoc.payload,
    ),
    synthCase(
      "files-index-offsets-overlap",
      "A container entry starts before the previous one ends.",
      synth((d) => {
        d.files[2].offset = 20;
      }).text,
      zsDoc.payload,
    ),
    synthCase(
      "files-index-tree-unsorted",
      "A tree whose paths are not strictly ascending.",
      JSON.stringify(treeUnsorted),
      treeOk.payload,
      { layout: "tree" },
    ),
    synthCase(
      "files-index-tree-digest-mismatch",
      "A tree whose `payload.sha256` is not its tree digest.",
      JSON.stringify(treeBadDigest),
      treeBadDigest.payload,
      { layout: "tree" },
    ),
  ];
  const filesWant: Record<string, unknown> = {
    "files-index-valid-container": { ok: true, files: set.c2.files.length },
    "files-index-valid-tree": { ok: true, files: set.tree2.files.length },
    "files-index-valid-zero-size-entry": { ok: true, files: 3 },
    "files-index-offsets-overlap": {
      ok: false,
      error: "files-layout-mismatch",
    },
  };
  for (const c of filesIndexCases) {
    const st = c.stored as ObjectSource;
    const bytes = "text" in st ? utf8(st.text) : set.blobs.get(st.blob)!;
    const r = refParseFilesIndex(
      ref,
      bytes,
      c.files as FilesRefMember,
      c.payload as { size: number; sha256: string },
    );
    const v = r.ok ? { ok: true, files: r.index.files.length } : r;
    const want = filesWant[c.id as string] ?? {
      ok: false,
      error: "files-index-invalid",
    };
    if (!sameJson(v, want)) fail(`${c.id as string}: ${JSON.stringify(v)}`);
    c.expect = v;
  }
  if (filesIndexCases.length !== 15) fail("filesIndexCases must be 15");

  // ── packSetIdCases ──
  const rec = (n: string) => records.get(n);
  const syn = (n: string) => sha256Hex(`pkey-content-corpus:release:${n}`);
  const setRows: [
    string,
    string,
    { packId: string; releaseSha256: string }[],
  ][] = [
    ["set-empty", "The empty set hashes the empty string.", []],
    [
      "set-one",
      "One pack release.",
      [
        {
          packId: "djdl.levels",
          releaseSha256: rec("djdl.levels@1.1.0").sha256,
        },
      ],
    ],
    [
      "set-three-unsorted",
      "Three releases given out of order: lines sort by pack-id bytes.",
      [
        {
          packId: "djdl.levels",
          releaseSha256: rec("djdl.levels@1.1.0").sha256,
        },
        {
          packId: "djdl.assets",
          releaseSha256: rec("djdl.assets@1.1.0").sha256,
        },
        { packId: "djdl.docs", releaseSha256: rec("djdl.docs@1.0.0").sha256 },
      ],
    ],
    [
      "set-dash-before-dot",
      "`a.b-c` sorts before `a.b.c` (0x2D before 0x2E).",
      [
        { packId: "a.b.c", releaseSha256: syn("a.b.c") },
        { packId: "a.b-c", releaseSha256: syn("a.b-c") },
      ],
    ],
    [
      "set-prefix",
      "`a` sorts before `a.b`.",
      [
        { packId: "a.b", releaseSha256: syn("a.b") },
        { packId: "a", releaseSha256: syn("a") },
      ],
    ],
    [
      "set-duplicate-pack",
      "A pack listed twice gives null.",
      [
        {
          packId: "djdl.levels",
          releaseSha256: rec("djdl.levels@1.0.0").sha256,
        },
        {
          packId: "djdl.levels",
          releaseSha256: rec("djdl.levels@1.1.0").sha256,
        },
      ],
    ],
    [
      "set-release-uppercase",
      "A release hash that is not lowercase hex gives null.",
      [
        {
          packId: "djdl.levels",
          releaseSha256: rec("djdl.levels@1.1.0").sha256.toUpperCase(),
        },
      ],
    ],
  ];
  const packSetIdCases = setRows.map(([id, description, entries]) => ({
    id,
    description,
    entries,
    expect: { packSetId: refPackSetId(entries) },
  }));
  const ps = Object.fromEntries(
    packSetIdCases.map((c) => [c.id, c.expect.packSetId]),
  );
  if (
    ps["set-empty"] !== sha256Hex("") ||
    ps["set-duplicate-pack"] !== null ||
    ps["set-release-uppercase"] !== null
  )
    fail("packSetIdCases: an expectation is off");
  if (
    ps["set-dash-before-dot"] !==
      sha256Hex(`a.b-c ${syn("a.b-c")}\na.b.c ${syn("a.b.c")}\n`) ||
    ps["set-prefix"] !== sha256Hex(`a ${syn("a")}\na.b ${syn("a.b")}\n`)
  )
    fail("packSetIdCases: the byte order is off");

  // ── stampCases ──
  const content = clone(records.appContent);
  const stamp = (doc: Record<string, unknown>): string => JSON.stringify(doc);
  const valid = { format: "pkey-content/1", ...content };
  const pins = content.pins as unknown[];
  const stampRows: [string, string, string][] = [
    ["stamp-valid", "The app record's `content` as a stamp.", stamp(valid)],
    [
      "stamp-format-unknown",
      "`format` is `pkey-content/2`.",
      stamp({ ...valid, format: "pkey-content/2" }),
    ],
    [
      "stamp-duplicate-member",
      "A duplicate `contentApi` member (strict JSON).",
      stamp(valid).replace('"contentApi":', '"contentApi":4,"contentApi":'),
    ],
    [
      "stamp-content-api-zero",
      "`contentApi` 0, below its minimum.",
      stamp({ ...valid, contentApi: 0 }),
    ],
    [
      "stamp-pin-duplicate",
      "The same pack pinned twice.",
      stamp({ ...valid, pins: [...pins, pins[0]] }),
    ],
    [
      "stamp-forward-members-ignored",
      "P4-12's reserved members, an unknown top-level member and an unknown delivery are ignored.",
      stamp({
        ...valid,
        holds: [{ pack: "djdl.levels" }],
        packChannels: { "djdl.levels": "beta" },
        expects: [
          ...(content.expects as unknown[]),
          { pack: "djdl.music", required: false, delivery: "background" },
        ],
        later: { anything: true },
      }),
    ],
  ];
  const stampCases = stampRows.map(([id, description, text]) => {
    let expect: Record<string, unknown> = {
      ok: false,
      error: "content-stamp-invalid",
    };
    const p = ref.parseStrict(text);
    if (
      p.ok &&
      isObj(p.value) &&
      p.value.format === "pkey-content/1" &&
      ref.stampContentClaims(text)
    )
      expect = {
        ok: true,
        content: {
          contentApi: p.value.contentApi,
          pins: p.value.pins,
          expects: p.value.expects,
        },
      };
    return { id, description, stamp: text, expect };
  });
  const okStamps = stampCases
    .filter((c) => c.expect.ok === true)
    .map((c) => c.id);
  if (!sameJson(okStamps, ["stamp-valid", "stamp-forward-members-ignored"]))
    fail(`stampCases: ok ${JSON.stringify(okStamps)}`);

  // ── frameWindowCases ──
  const hex = (b: readonly number[] | Uint8Array): string =>
    [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const pf = set.blobs.get("deltas/v1-v2.pf.zst")!;
  const pfh = pf[4]!;
  const pfLen =
    5 +
    (pfh & 0x20 ? 0 : 1) +
    [0, 1, 2, 4][pfh & 3]! +
    (pfh >> 6 === 0 ? (pfh & 0x20 ? 1 : 0) : [0, 2, 4, 8][pfh >> 6]!);
  const M = ZSTD_MAGIC;
  const fwRows: [string, string, number[] | Uint8Array, number | null][] = [
    [
      "frame-window-fcs1",
      "Single segment, a 1-byte content size: the window is 255.",
      [...M, 0x20, 0xff],
      255,
    ],
    [
      "frame-window-fcs2",
      "Single segment, a 2-byte content size (plus 256): 65,791.",
      [...M, 0x60, 0xff, 0xff],
      65791,
    ],
    [
      "frame-window-fcs4-patch-from",
      "The header of `deltas/v1-v2.pf.zst`: single segment, its content size.",
      pf.subarray(0, pfLen),
      pfWindow,
    ],
    [
      "frame-window-fcs8",
      "Single segment, an 8-byte content size of 2^32 − 1.",
      [...M, 0xe0, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0],
      4294967295,
    ],
    [
      "frame-window-fcs8-saturated",
      "An 8-byte content size with its top bit set counts as 2^32.",
      [...M, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0x80],
      4294967296,
    ],
    [
      "frame-window-descriptor",
      "Window_Descriptor 0x5a: 2^21 + 2 × 2^18.",
      [...M, 0x00, 0x5a],
      2621440,
    ],
    [
      "frame-window-descriptor-max",
      "Window_Descriptor 0xff is above 2^32: it counts as 2^32.",
      [...M, 0x00, 0xff],
      4294967296,
    ],
    [
      "frame-window-descriptor-ignores-fcs",
      "Without Single_Segment the window comes from the descriptor (0x00: 1,024), never from the 2-byte content size.",
      [...M, 0x40, 0x00, 0xff, 0xff],
      1024,
    ],
    [
      "frame-window-dict-id-before-fcs",
      "A 1-byte Dictionary_ID precedes the content size: the window is the content size, 16.",
      [...M, 0x21, 0x07, 0x10],
      16,
    ],
    [
      "frame-window-bad-magic",
      "The magic's last byte is wrong.",
      [0x28, 0xb5, 0x2f, 0xfe, 0x20, 0xff],
      null,
    ],
    [
      "frame-window-skippable",
      "A skippable frame's magic (`50 2A 4D 18`).",
      [0x50, 0x2a, 0x4d, 0x18, 0x20, 0xff],
      null,
    ],
    [
      "frame-window-reserved-bit",
      "The descriptor's reserved bit (0x08) is set.",
      [...M, 0x28, 0xff],
      null,
    ],
    [
      "frame-window-truncated",
      "An 8-byte content size cut short.",
      [...M, 0xe0, 0xff, 0xff],
      null,
    ],
  ];
  const frameWindowCases = fwRows.map(([id, description, bytes, want]) => {
    const got = refFrameWindow(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    if (got !== want) fail(`${id}: ${got} != ${want}`);
    return { id, description, header: hex(bytes), expect: { window: got } };
  });

  // ── refs.json consistency (§4.2) ──
  const refsWant: Record<string, number> = {
    "payload/v2.full.zst": set.c2.payload.size,
    "files/v1.gaps.zst":
      set.c1.payload.size - set.c1.files.reduce((a, f) => a + f.size, 0),
    "tree/v1.full.zst": set.tree1.payload.size,
    "tree/v2.full.zst": set.tree2.payload.size,
  };
  for (const [n, r] of Object.entries(set.refsJson)) {
    if (
      r.codec !== "zstd" ||
      !(r.bytes < r.size) ||
      r.size !== refsWant[n] ||
      !SHA256_RE.test(r.sha256)
    )
      fail(`refs.json ${n} is inconsistent with the shipped indexes`);
  }

  const blobsTable: Record<string, { size: number; sha256: string }> = {};
  for (const n of [...set.blobs.keys()].sort(compareBytes)) {
    const b = set.blobs.get(n)!;
    blobsTable[n] = { size: b.byteLength, sha256: sha256Hex(b) };
  }
  const cases = {
    contentCorpusVersion: 1,
    description:
      "The content corpus (plans/P4-01.md §4.4; WIRE-CONTRACT-V4 §2.6): the files index and its path rules, full, delta and file apply with negative cases, `packSetId`, the content stamp and `frameWindow`. Generated by `tools/gen-content-corpus.ts` from the committed inputs in `blobs/` (never compressed by a normal run): do not hand-edit. A runner first checks every file under `blobs/` against `blobs`, a harness error otherwise. `<ref>` is `{blob, codec?, size?, mutate?}`: the named blob, decoded when `codec` is `zstd` (to `size` bytes), then mutated (`truncate {length}`, `xor {offset, value}`). An apply case's `installed` is materialised (decoded, then mutated): its files are `installed.files`'s entries sliced from `installed.payload`, each with the SHA-256 the index claims. `objects` is the blob store by stored SHA-256, read raw (mutations apply to the stored bytes): the fetcher answers `objects[sha256]`, a `<ref>` or `{text}` (UTF-8). `variant` holds the record members the applier reads; `delta` indexes `variant.deltas` (a `payload` delta for `strategy: delta`, a `files` set for `strategy: file`; absent means the `file` strategy). `skipBaseCheck` is a test-only switch. Verdicts compare by canonical JSON: `{ok: true, …}` with the counters stated, or `{ok: false, error, path?}`; the first failure wins.",
    params: { zstd: ZSTD_CLI_VERSION, zstdLevel: ZSTD_LEVEL },
    payloads: {
      v1: { sha256: S1, size: N1 },
      v2: { sha256: S2, size: N2 },
      treeV1: set.tree1.payload,
      treeV2: set.tree2.payload,
      t1: set.t1.payload,
      t2: set.t2.payload,
    },
    blobs: blobsTable,
    applyCases,
    pathCases,
    filesIndexCases,
    packSetIdCases,
    stampCases,
    frameWindowCases,
  };

  const { planMatrix, planRealPins } = buildPlanMatrix(set, records);
  return { cases, planMatrix, planRealPins };
}

// ── plan-matrix.json ───────────────────────────────────────────────────────────────────────────

const H = (c: string): string => c.repeat(64);

function planBase(): Record<string, any> {
  const recs = Array.from({ length: 10 }, (_, i) => [
    `c${i}`,
    1000000,
    400000,
    0,
    400000 * i,
  ]);
  return {
    target: {
      release: "r3",
      payload: { sha256: H("a"), size: 10000000 },
      full: { bytes: 4000000 },
      platform: null,
      chunks: { indexBytes: 64 + 48 * 11, records: recs },
      files: {
        indexBytes: 2000,
        gapsBytes: 1000,
        files: [10, 20, 30, 700000, 500000].map((b, i) => ({
          sha256: `f${i}`,
          blobBytes: b,
        })),
      },
      deltas: [
        {
          id: "r1-r3",
          method: PATCH_METHOD,
          from: H("1"),
          memBytes: 25000000,
          artifacts: [{ sha256: H("d"), bytes: 300000 }],
        },
      ],
    },
    installed: [
      {
        release: "r1",
        payloadSha256: H("1"),
        chunks: { ids: Array.from({ length: 7 }, (_, i) => `c${i}`) },
        files: ["f0", "f1", "f2"],
      },
    ],
    caps: {
      strategies: ["delta", "chunk", "file", "full"],
      patchMethods: [PATCH_METHOD],
      transports: ["pkey-cdn"],
      memBudget: 64 * 2 ** 20,
      freeDisk: 2 ** 30,
    },
  };
}

/** A7's 19 synthetic rows, inputs unchanged (`gen/planref.py`). */
function syntheticRows(): {
  id: string;
  description: string;
  input: Record<string, any>;
}[] {
  const out: { id: string; description: string; input: Record<string, any> }[] =
    [];
  const add = (
    id: string,
    description: string,
    fn: (i: Record<string, any>) => void,
  ): void => {
    const i = planBase();
    fn(i);
    out.push({ id, description, input: i });
  };
  add("plan-noop", "The installed payload already is the target.", (i) =>
    i.installed.push({
      release: "r3",
      payloadSha256: H("a"),
      chunks: null,
      files: null,
    }),
  );
  add(
    "plan-platform",
    "The pack is bound to a platform transport the SDK supports.",
    (i) => {
      i.target.platform = { transport: "apple-ba" };
      i.caps.transports.push("apple-ba");
    },
  );
  add(
    "plan-platform-unsupported",
    "Bound to a platform transport the SDK lacks: no silent CDN fallback.",
    (i) => {
      i.target.platform = { transport: "play-pad" };
    },
  );
  add(
    "plan-delta-wins",
    "delta 300,000 B beats chunk (3 contiguous missing chunks), file and full.",
    () => {},
  );
  add(
    "plan-delta-other-base",
    "The only delta starts from a release that is not installed.",
    (i) => {
      i.target.deltas[0].from = H("0");
    },
  );
  add(
    "plan-delta-over-memory",
    "The delta needs more memory than the budget.",
    (i) => {
      i.caps.memBudget = 16 * 2 ** 20;
    },
  );
  add(
    "plan-delta-method-unsupported",
    "The SDK does not advertise zstd-patch-from.",
    (i) => {
      i.caps.patchMethods = [];
    },
  );
  add(
    "plan-no-seed-index",
    "No installed chunk index and no delta: file beats full.",
    (i) => {
      i.installed[0].chunks = null;
      i.target.deltas = [];
    },
  );
  add(
    "plan-first-install",
    "Nothing installed: only full is feasible.",
    (i) => {
      i.installed = [];
    },
  );
  add(
    "plan-request-heavy",
    "50 scattered missing chunks: request weight makes full cheaper than chunk.",
    (i) => {
      const recs = Array.from({ length: 100 }, (_, k) => [
        `s${k}`,
        10000,
        5000,
        0,
        5000 * k,
      ]);
      Object.assign(i.target, {
        payload: { sha256: H("a"), size: 1000000 },
        full: { bytes: 500000 },
        deltas: [],
        files: null,
        chunks: { indexBytes: 64 + 48 * 101, records: recs },
      });
      i.installed[0].chunks = {
        ids: Array.from({ length: 50 }, (_, k) => `s${2 * k}`),
      };
    },
  );
  add(
    "plan-tie-rank",
    "delta and chunk cost exactly the same: rank prefers delta.",
    (i) => {
      i.target.deltas[0].artifacts = [
        { sha256: H("d"), bytes: 600000 },
        { sha256: H("e"), bytes: 600592 },
      ];
    },
  );
  add(
    "plan-two-deltas",
    "Three deltas from the installed base: the cheapest wins, equal cost keeps menu order.",
    (i) => {
      const d0 = i.target.deltas[0];
      i.target.deltas = [
        { ...d0, id: "big", artifacts: [{ sha256: H("d"), bytes: 900000 }] },
        {
          ...d0,
          id: "small-a",
          artifacts: [{ sha256: H("e"), bytes: 200000 }],
        },
        {
          ...d0,
          id: "small-b",
          artifacts: [{ sha256: H("f"), bytes: 200000 }],
        },
      ];
    },
  );
  add(
    "plan-disk-limited",
    "Free disk admits delta and chunk but not file or full.",
    (i) => {
      i.caps.freeDisk = 11201000;
    },
  );
  add("plan-insufficient-disk", "No strategy fits in free disk.", (i) => {
    i.caps.freeDisk = 5000000;
  });
  add(
    "plan-two-seeds",
    "Two installed releases seed disjoint chunks; only c9 is fetched.",
    (i) => {
      i.target.deltas = [];
      i.installed = [
        {
          release: "r1",
          payloadSha256: H("1"),
          chunks: { ids: Array.from({ length: 5 }, (_, k) => `c${k}`) },
          files: null,
        },
        {
          release: "r2",
          payloadSha256: H("2"),
          chunks: { ids: Array.from({ length: 4 }, (_, k) => `c${k + 5}`) },
          files: null,
        },
      ];
    },
  );
  add(
    "plan-run-rules",
    "Duplicate ids are fetched once; a gap or a bundle change starts a new request run; a seeded record between two missing ones does not break their run.",
    (i) => {
      const recs = [
        ["a", 1000, 100, 0, 0],
        ["b", 1000, 100, 0, 100],
        ["a", 1000, 100, 0, 0],
        ["c", 1000, 100, 0, 300],
        ["k", 1000, 100, 2, 0],
        ["d", 1000, 100, 0, 400],
        ["e", 1000, 100, 1, 0],
      ];
      Object.assign(i.target, {
        payload: { sha256: H("a"), size: 7000 },
        full: { bytes: 400000 },
        deltas: [],
        files: null,
        chunks: { indexBytes: 64 + 48 * 10, records: recs },
      });
      i.installed[0].chunks = { ids: ["k", "zz"] };
    },
  );
  add(
    "plan-full-always-last",
    "full is cheaper than file, but fallbacks still list full last.",
    (i) => {
      i.target.files.files[3].blobBytes = 5000000;
    },
  );
  add(
    "plan-caps-full-only",
    "The SDK advertises no incremental strategy; full is always available.",
    (i) => {
      i.caps.strategies = [];
    },
  );
  add(
    "plan-request-weight",
    "As plan-delta-other-base with requestWeight 4 MiB: chunk's second request outweighs its 2.8 MB saving, so full wins.",
    (i) => {
      i.target.deltas[0].from = H("0");
      i.caps.requestWeight = 4 * 2 ** 20;
    },
  );
  return out;
}

function buildPlanMatrix(
  set: ContentSet,
  records: ContentRecords,
): { planMatrix: Record<string, unknown>; planRealPins: Set<string> } {
  const rows: {
    id: string;
    description: string;
    input: Record<string, any>;
    expect?: unknown;
  }[] = syntheticRows();
  if (rows.length !== 19) fail("A7's synthetic plan rows must be 19");
  // The four real rows, rebuilt from the content set through `planTarget` (§4.5).
  const v1Rec = records.get("djdl.levels@1.0.0");
  const v2Rec = records.get("djdl.levels@1.1.0");
  const variant = (v2Rec.doc.variants as Record<string, any>[])[0]!;
  const target = refPlanTarget(variant, v2Rec.sha256, set.c2);
  const filesDelta = (variant.deltas as Record<string, any>[]).find(
    (d) => d.scope === "files",
  )!;
  const inp = {
    target,
    installed: [
      {
        release: v1Rec.sha256,
        payloadSha256: set.c1.payload.sha256,
        chunks: null,
        files: set.c1.files.map((f) => f.sha256),
      },
    ],
    caps: planBase().caps,
  };
  rows.push({
    id: "plan-real-v1-v2",
    description:
      "The content set's own v1 → v2 menu (`djdl.levels@1.1.0` through `planTarget`, v1 installed; no chunk index in v1).",
    input: inp,
  });
  const i2 = clone(inp);
  i2.caps.strategies = ["chunk", "file", "full"];
  rows.push({
    id: "plan-real-no-delta",
    description: "As plan-real-v1-v2 for an SDK without delta support.",
    input: i2,
  });
  const i3 = clone(inp);
  i3.caps.memBudget = filesDelta.memBytes;
  rows.push({
    id: "plan-real-low-memory",
    description:
      "A memory budget of the `files` set's `memBytes` excludes the whole-payload delta: the packed set remains.",
    input: i3,
  });
  const i4 = clone(i2);
  (i4.caps as Record<string, unknown>).requestWeight = 65536;
  rows.push({
    id: "plan-real-no-delta-64k",
    description: "As plan-real-no-delta with requestWeight 65536.",
    input: i4,
  });
  // Two tree rows (§4.5): a tree's full costs its index and a second request.
  const treeBase = (): Record<string, any> => {
    const i = planBase();
    i.target.full = { bytes: 4002000, requests: 2 };
    i.target.chunks = null;
    i.target.deltas = [];
    i.target.files.gapsBytes = 0;
    i.installed[0].chunks = null;
    return i;
  };
  const ti1 = treeBase();
  ti1.installed = [];
  rows.push({
    id: "plan-tree-first-install",
    description:
      "A tree's first install: full costs the full object plus its index, in two requests.",
    input: ti1,
  });
  rows.push({
    id: "plan-tree-file",
    description:
      "A tree with three of five files installed: file (no gaps object, so one request for the index and one per missing blob) beats the two-request full.",
    input: treeBase(),
  });
  for (const r of rows) r.expect = refPlan(r.input);
  const exp = Object.fromEntries(
    rows.map((r) => [r.id, r.expect as Record<string, any>]),
  );
  const wantStrategy: Record<string, string> = {
    "plan-real-v1-v2": "delta",
    "plan-real-low-memory": "delta",
    "plan-tree-first-install": "full",
    "plan-tree-file": "file",
  };
  for (const [id, s] of Object.entries(wantStrategy))
    if (exp[id]!.strategy !== s)
      fail(`${id} must choose ${s}: ${JSON.stringify(exp[id])}`);
  if (exp["plan-real-low-memory"]!.delta !== filesDelta.patch.sha256)
    fail("plan-real-low-memory must choose the packed set");
  if (exp["plan-tree-first-install"]!.requests !== 2)
    fail("a tree's full is two requests");
  // A7's synthetic expectations quoted in §4.5 and A7 §4.4.
  const dw = exp["plan-delta-wins"]!;
  if (
    !sameJson(dw, {
      strategy: "delta",
      delta: "r1-r3",
      bytes: 300000,
      requests: 1,
      cost: 316384,
      peakDisk: 10300000,
      fallbacks: [
        { strategy: "chunk", bytes: 1200592, requests: 2, cost: 1233360 },
        { strategy: "file", bytes: 1203000, requests: 4, cost: 1268536 },
        { strategy: "full", bytes: 4000000, requests: 1, cost: 4016384 },
      ],
    })
  )
    fail(`plan-delta-wins drifted from A7: ${JSON.stringify(dw)}`);

  const planRealPins = new Set<string>();
  const real = target as Record<string, any>;
  if (real.full?.bytes === contentRef(set, "payload/v2.full.zst").bytes)
    planRealPins.add("payload/v2.full.zst");

  // variantCases (§4.5).
  const fc = (layout = "container", format = FILES_FORMAT) => ({
    format,
    layout,
    codec: "zstd",
    size: 4096,
  });
  const vrows: [
    string,
    string,
    Record<string, unknown>[],
    { engine: string | null; axes: Record<string, string[]> },
  ][] = [
    [
      "variant-unvaried",
      "One unvaried variant.",
      [{ variant: {}, files: fc() }],
      { engine: null, axes: {} },
    ],
    [
      "variant-texture-preference",
      "The host's first preferred texture wins.",
      [
        { variant: { texture: "s3tc" }, files: fc() },
        { variant: { texture: "etc2" }, files: fc() },
        { variant: { texture: "astc" }, files: fc() },
      ],
      { engine: null, axes: { texture: ["astc", "etc2"] } },
    ],
    [
      "variant-texture-none-eligible",
      "No variant's texture is in the host's list.",
      [
        { variant: { texture: "s3tc" }, files: fc() },
        { variant: { texture: "etc2" }, files: fc() },
      ],
      { engine: null, axes: { texture: ["bptc"] } },
    ],
    [
      "variant-axis-without-prefs",
      "A declared axis the host has no preferences for.",
      [{ variant: { locale: "fr" }, files: fc() }],
      { engine: null, axes: {} },
    ],
    [
      "variant-two-axes-axis-order",
      "Axes compare in name byte order: `locale` before `texture`, so fr+etc2 beats en+astc.",
      [
        { variant: { locale: "en", texture: "astc" }, files: fc() },
        { variant: { locale: "fr", texture: "etc2" }, files: fc() },
        { variant: { locale: "de", texture: "astc" }, files: fc() },
      ],
      {
        engine: null,
        axes: { texture: ["astc", "etc2"], locale: ["fr", "en"] },
      },
    ],
    [
      "variant-engine-mismatch-skipped",
      "A variant requiring another engine is skipped.",
      [
        {
          variant: { texture: "s3tc" },
          requires: { engine: "godot-4.6" },
          files: fc(),
        },
        {
          variant: { texture: "etc2" },
          requires: { engine: "godot-4.7" },
          files: fc(),
        },
      ],
      { engine: "godot-4.7", axes: { texture: ["s3tc", "etc2"] } },
    ],
    [
      "variant-engine-absent-matches",
      "A variant without `requires.engine` matches any host.",
      [{ variant: { texture: "s3tc" }, files: fc() }],
      { engine: "godot-4.7", axes: { texture: ["s3tc"] } },
    ],
    [
      "variant-host-engine-null",
      "Outside Godot (engine null) only variants without an engine requirement are eligible.",
      [
        {
          variant: { texture: "s3tc" },
          requires: { engine: "godot-4.7" },
          files: fc(),
        },
        { variant: { texture: "etc2" }, files: fc() },
      ],
      { engine: null, axes: { texture: ["s3tc", "etc2"] } },
    ],
    [
      "variant-value-case-sensitive",
      "Values compare by bytes: `ASTC` is not `astc`.",
      [
        { variant: { texture: "ASTC" }, files: fc() },
        { variant: { texture: "etc2" }, files: fc() },
      ],
      { engine: null, axes: { texture: ["astc", "etc2"] } },
    ],
    [
      "variant-unknown-layout-skipped",
      "The preferred variant's layout is unknown: the next one wins.",
      [
        { variant: { texture: "astc" }, files: fc("strata") },
        { variant: { texture: "etc2" }, files: fc() },
      ],
      { engine: null, axes: { texture: ["astc", "etc2"] } },
    ],
    [
      "variant-tree-index-unreadable-skipped",
      "A tree whose index format is `pkey-files/2` is unusable.",
      [
        { variant: { texture: "astc" }, files: fc("tree", "pkey-files/2") },
        { variant: { texture: "etc2" }, files: fc("tree") },
      ],
      { engine: null, axes: { texture: ["astc", "etc2"] } },
    ],
  ];
  const variantCases = vrows.map(([id, description, variants, prefs]) => ({
    id,
    description,
    variants,
    prefs,
    expect: refSelectVariant(variants, prefs),
  }));
  const vwant: Record<string, unknown> = {
    "variant-unvaried": { index: 0 },
    "variant-texture-preference": { index: 2 },
    "variant-texture-none-eligible": { error: "pack-no-variant" },
    "variant-axis-without-prefs": { error: "pack-no-variant" },
    "variant-two-axes-axis-order": { index: 1 },
    "variant-engine-mismatch-skipped": { index: 1 },
    "variant-engine-absent-matches": { index: 0 },
    "variant-host-engine-null": { index: 1 },
    "variant-value-case-sensitive": { index: 1 },
    "variant-unknown-layout-skipped": { index: 1 },
    "variant-tree-index-unreadable-skipped": { index: 1 },
  };
  for (const c of variantCases)
    if (!sameJson(c.expect, vwant[c.id]))
      fail(`${c.id}: ${JSON.stringify(c.expect)}`);

  // targetCases (§4.5): synthetic variants and indexes of a few entries.
  const tgt = buildTargetCases();
  return {
    planMatrix: {
      planMatrixVersion: 1,
      description:
        'The install planner, variant selection and target mapping (plans/P4-01.md §2.9, §4.5; WIRE-CONTRACT-V4 §11.4, informative). Generated by `tools/gen-content-corpus.ts`; do not hand-edit. `rows` pin `plan(input)`: A7 §4.2 with `requestWeight` (default below; `caps.requestWeight` overrides) and `full` as `{bytes, requests?}` costing `requests ?? 1`; chunk targets and seeds are inline (`records` as `[id, len, clen, bundle, offset]`, `ids`), so the planner never parses an index. Results are verdicts, never exceptions: `{strategy, delta?, transport?, bytes, requests, cost, peakDisk, fallbacks}` or `{error}`. The `plan-real-*` rows are the content set\'s own menu through `planTarget`. `variantCases` pin `selectVariant(variants, prefs)` (`{index}` or `{error: "pack-no-variant"}`), `targetCases` `planTarget(variant, recordSha256, filesIndex)`. Compare by canonical JSON.',
      requestWeight: PLAN_REQUEST_WEIGHT,
      rows,
      variantCases,
      targetCases: tgt,
    },
    planRealPins,
  };
}

function buildTargetCases(): Record<string, unknown>[] {
  const ref = (
    c: string,
    bytes: number,
    size: number,
    codec = "zstd",
  ): ObjectRef => ({
    sha256: H(c),
    bytes,
    size,
    codec,
  });
  const payload = { size: 3000, sha256: H("a") };
  const index = (layout: string): FilesIndex => ({
    format: FILES_FORMAT,
    layout,
    payload,
    files: [
      {
        path: "a.bin",
        ...(layout === "container" ? { offset: 0 } : {}),
        size: 1000,
        sha256: H("1"),
        blob: { sha256: H("4"), bytes: 400, codec: "zstd" },
      },
      {
        path: "b.bin",
        ...(layout === "container" ? { offset: 1000 } : {}),
        size: 2000,
        sha256: H("2"),
        blob: { sha256: H("2"), bytes: 2000, codec: "none" },
      },
    ],
  });
  const payloadDelta = {
    method: PATCH_METHOD,
    scope: "payload",
    from: H("0"),
    memBytes: 6000,
    artifact: { sha256: H("d"), bytes: 500 },
  };
  const filesDelta = {
    method: PATCH_METHOD,
    scope: "files",
    from: H("0"),
    memBytes: 4000,
    patch: ref("e", 120, 300),
    data: { sha256: H("f"), bytes: 450 },
  };
  const container = (): Record<string, any> => ({
    variant: {},
    payload,
    full: ref("b", 1500, 3000),
    files: {
      format: FILES_FORMAT,
      layout: "container",
      ...ref("c", 200, 600),
      gaps: ref("9", 0, 0, "none"),
    },
    deltas: [clone(payloadDelta), clone(filesDelta)],
  });
  const tree = (): Record<string, any> => {
    const v = container();
    v.files = { format: FILES_FORMAT, layout: "tree", ...ref("c", 200, 600) };
    v.deltas = [clone(filesDelta)];
    return v;
  };
  const rows: [
    string,
    string,
    Record<string, any>,
    FilesIndex | null,
    (t: Record<string, any>) => boolean,
  ][] = [];
  const add = (
    id: string,
    description: string,
    mut: (v: Record<string, any>) => void,
    base: () => Record<string, any>,
    idx: FilesIndex | null,
    check: (t: Record<string, any>) => boolean,
  ): void => {
    const v = base();
    mut(v);
    rows.push([id, description, v, idx, check]);
  };
  const ci = index("container");
  const ti = index("tree");
  add(
    "target-container-full-only",
    "A container planned without its index (a first install): `full` and the `payload` delta; `files` null drops the `files` delta.",
    () => {},
    container,
    null,
    (t) => t.full.requests === 1 && t.files === null && t.deltas.length === 1,
  );
  add(
    "target-container-menu",
    "A container with its index: `full`, `files` with gaps, and both deltas, the set's artifacts being index, gaps, descriptor and data.",
    () => {},
    container,
    ci,
    (t) =>
      t.files.gapsBytes === 0 &&
      t.deltas.length === 2 &&
      t.deltas[1].artifacts.length === 4,
  );
  add(
    "target-tree",
    "A tree: `full` costs the object plus the index in two requests; no gaps; the set's artifacts are index, descriptor and data.",
    () => {},
    tree,
    ti,
    (t) =>
      t.full.requests === 2 &&
      t.full.bytes === 1700 &&
      t.files.gapsBytes === 0 &&
      t.deltas[0].artifacts.length === 3,
  );
  add(
    "target-unknown-layout",
    "An unknown layout makes the variant unusable: everything null, no deltas.",
    (v) => {
      v.files.layout = "strata";
    },
    container,
    ci,
    (t) => t.full === null && t.files === null && t.deltas.length === 0,
  );
  add(
    "target-full-codec-unknown",
    "An unknown `full` codec: `full` null, the deltas kept.",
    (v) => {
      v.full.codec = "lz4";
    },
    container,
    ci,
    (t) => t.full === null && t.deltas.length === 2,
  );
  add(
    "target-full-size-differs",
    "`full.size` differs from `payload.size`: `full` null.",
    (v) => {
      v.full.size = 2999;
    },
    container,
    ci,
    (t) => t.full === null && t.files !== null,
  );
  add(
    "target-files-format-unknown",
    "Index format `pkey-files/2`: `files` null and the `files` delta dropped; `full` and the `payload` delta kept.",
    (v) => {
      v.files.format = "pkey-files/2";
    },
    container,
    ci,
    (t) => t.files === null && t.deltas.length === 1 && t.full !== null,
  );
  add(
    "target-files-codec-unknown",
    "An unknown index codec: as target-files-format-unknown.",
    (v) => {
      v.files.codec = "lz4";
    },
    container,
    ci,
    (t) => t.files === null && t.deltas.length === 1 && t.full !== null,
  );
  add(
    "target-index-over-max",
    "`files.size` above MAX_FILES_INDEX_BYTES: as target-files-format-unknown.",
    (v) => {
      v.files.size = MAX_FILES_INDEX_BYTES + 1;
    },
    container,
    ci,
    (t) => t.files === null && t.deltas.length === 1 && t.full !== null,
  );
  add(
    "target-gaps-codec-unknown",
    "An unknown gaps codec on a container: the index is not rebuildable, as target-files-format-unknown.",
    (v) => {
      v.files.gaps.codec = "lz4";
    },
    container,
    ci,
    (t) => t.files === null && t.deltas.length === 1 && t.full !== null,
  );
  add(
    "target-patch-codec-unknown",
    "An unknown descriptor codec drops that `files` delta; `files` kept.",
    (v) => {
      v.deltas[1].patch.codec = "lz4";
    },
    container,
    ci,
    (t) => t.files !== null && t.deltas.length === 1,
  );
  add(
    "target-tree-index-unreadable",
    "A tree whose index is unreadable is unusable: everything null.",
    (v) => {
      v.files.format = "pkey-files/2";
    },
    tree,
    ti,
    (t) => t.full === null && t.files === null && t.deltas.length === 0,
  );
  add(
    "target-unknown-scope-dropped",
    "A delta of an unknown scope is dropped.",
    (v) => {
      v.deltas.push({
        method: PATCH_METHOD,
        scope: "chunks",
        from: H("0"),
        memBytes: 10,
      });
    },
    container,
    ci,
    (t) => t.deltas.length === 2,
  );
  add(
    "target-unknown-method-kept",
    "An unknown method is passed through for the planner's capabilities to refuse.",
    (v) => {
      v.deltas[0].method = "godot-delta-pck";
    },
    container,
    ci,
    (t) => t.deltas.length === 2 && t.deltas[0].method === "godot-delta-pck",
  );
  if (rows.length !== 14) fail("targetCases must be 14");
  return rows.map(([id, description, variant, filesIndex, check]) => {
    const expect = refPlanTarget(variant, H("7"), filesIndex);
    if (!check(expect as Record<string, any>))
      fail(`${id}: ${JSON.stringify(expect)}`);
    return {
      id,
      description,
      recordSha256: H("7"),
      variant,
      filesIndex,
      expect,
    };
  });
}

/** `--check`'s guard against a `content/` directory in a mirror (content/ is source-only). */
export function contentStrays(mirrors: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of mirrors)
    if (existsSync(join(m, "content"))) out.push(join(m, "content"));
  // A stray file directly under content/ (only cases.json and blobs/ belong there).
  for (const e of existsSync(CONTENT_DIR) ? readdirSync(CONTENT_DIR) : [])
    if (e !== CONTENT_CASES_NAME && e !== "blobs")
      out.push(join(CONTENT_DIR, e));
  return out;
}
