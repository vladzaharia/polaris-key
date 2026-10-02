// The files index, `pkey-files/1`, its path rules and `treeDigest` (plans/P4-01.md §2.7;
// WIRE-CONTRACT-V4 §2.6). The Worker's ingest, the CLI and every applier run these.
// Pure over bytes (WebCrypto SHA-256 only); the zstd decoder is the caller's.

import { scanStrictJson, type NonWireIntegers } from "@polaris-key/jws";
import {
  FILES_FORMAT,
  MAX_FILES_INDEX_BYTES,
  MAX_INDEX_FILES,
  MAX_PACK_PATH_BYTES,
} from "@polaris-key/protocol/core";
import type {
  FilesIndexDoc,
  FilesIndexEntry,
} from "@polaris-key/protocol/packs";
import { isWireInteger } from "../claims.js";
import { SHA256_RE, has, isObject, utf8Length } from "./claims.js";
import { compareBytes } from "./variant.js";

/** The codes `parseFilesIndex` and `checkPaths` return (`conformance/parity/errors.json`). */
export type FilesErrorCode =
  | "files-index-invalid"
  | "files-unsafe-path"
  | "files-duplicate-path"
  | "files-case-collision"
  | "files-path-conflict"
  | "files-layout-mismatch";

export type CheckPathsResult =
  | { ok: true }
  | {
      ok: false;
      error: Exclude<
        FilesErrorCode,
        "files-index-invalid" | "files-layout-mismatch"
      >;
      path: string;
    };

const BAD_CHARS = new Set(["\\", ":", "*", "?", '"', "<", ">", "|"]);
const DEVICES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ..."123456789".split("").flatMap((d) => [`com${d}`, `lpt${d}`]),
]);

/** ASCII-only lowercase: paths are ASCII by rule 2, so nothing else needs folding. */
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Path rules 1–3 (A7 §3.3) and the `.pkey` addition (plans/P4-01.md §2.7). */
function pathSafe(path: string): boolean {
  const n = utf8Length(path);
  if (n < 1 || n > MAX_PACK_PATH_BYTES) return false;
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || BAD_CHARS.has(path[i]!)) return false;
  }
  const segments = path.split("/");
  if (asciiLower(segments[0]!) === ".pkey") return false;
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return false;
    if (s.endsWith(" ") || s.endsWith(".")) return false;
    if (DEVICES.has(asciiLower(s.split(".")[0]!))) return false;
  }
  return true;
}

/**
 * The path rules, in order (plans/P4-01.md §2.7, A7 §3.3): a path that breaks rules 1–3 or whose
 * first segment is `.pkey` (any case) is `files-unsafe-path`; an exact duplicate is
 * `files-duplicate-path`; an ASCII-case-insensitive duplicate `files-case-collision`; a path
 * that is a directory prefix of another, or has one as its prefix (case-insensitively),
 * `files-path-conflict`. The later path is reported. Run before any byte is written.
 */
export function checkPaths(paths: readonly string[]): CheckPathsResult {
  const seen = new Set<string>();
  const lower = new Set<string>();
  const dirs = new Set<string>();
  for (const path of paths) {
    if (typeof path !== "string" || !pathSafe(path))
      return { ok: false, error: "files-unsafe-path", path: String(path) };
    if (seen.has(path))
      return { ok: false, error: "files-duplicate-path", path };
    const lp = asciiLower(path);
    if (lower.has(lp))
      return { ok: false, error: "files-case-collision", path };
    const parts = lp.split("/");
    const prefixes: string[] = [];
    for (let k = 1; k < parts.length; k++)
      prefixes.push(parts.slice(0, k).join("/"));
    if (dirs.has(lp) || prefixes.some((x) => lower.has(x)))
      return { ok: false, error: "files-path-conflict", path };
    seen.add(path);
    lower.add(lp);
    for (const x of prefixes) dirs.add(x);
  }
  return { ok: true };
}

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer,
  );
  return hex(new Uint8Array(digest));
}

/**
 * `treeDigest` (plans/P4-01.md §2.7): the lowercase hex SHA-256 of the UTF-8 text made of one
 * line `<sha256hex> <size> <path>\n` per file, sorted by path bytes; size in decimal without
 * leading zeros. An empty tree hashes the empty string.
 */
export async function treeDigest(
  files: readonly { path: string; size: number; sha256: string }[],
): Promise<string> {
  const lines = [...files]
    .sort((a, b) => compareBytes(a.path, b.path))
    .map((f) => `${f.sha256} ${String(f.size)} ${f.path}\n`)
    .join("");
  return sha256Hex(new TextEncoder().encode(lines));
}

/** A zstd decoder for one frame with its content size (`@polaris-key/zstd-wasm`'s `decode`,
 *  `node:zlib`, …). It may throw; any failure is `files-index-invalid`. */
export type ZstdDecode = (
  frame: Uint8Array,
  size: number,
) => Uint8Array | Promise<Uint8Array>;

/** The record's `files` member: an object ref plus `format`, `layout` and `gaps`. */
export interface FilesIndexRef {
  sha256: string;
  bytes: number;
  size: number;
  codec: string;
  format?: string;
  layout: string;
  gaps?: { size: number };
}

export interface ParseFilesIndexOptions {
  /** Decodes a `codec: "zstd"` index. Without it, a zstd index is `files-index-invalid`. */
  decode?: ZstdDecode;
  /** The largest `ref.size` accepted, `MAX_FILES_INDEX_BYTES` by default. The Worker passes
   *  its own, smaller, `MAX_PUBLISHED_INDEX_BYTES`. */
  maxBytes?: number;
}

export type ParseFilesIndexResult =
  | { ok: true; index: FilesIndexDoc }
  | { ok: false; error: FilesErrorCode; path?: string };

const invalid: ParseFilesIndexResult = {
  ok: false,
  error: "files-index-invalid",
};

function strictParse(
  bytes: Uint8Array,
): { value: unknown; nonWire: NonWireIntegers } | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) return null;
  const scan = scanStrictJson(text);
  if (!scan.ok) return null;
  try {
    return {
      value: JSON.parse(text) as unknown,
      nonWire: scan.nonWireIntegers,
    };
  } catch {
    return null;
  }
}

/** The member rules of one entry (plans/P4-01.md §2.7), integer rule included. */
function entryOk(
  e: unknown,
  i: number,
  container: boolean,
  nonWire: NonWireIntegers,
): e is FilesIndexEntry {
  if (!isObject(e)) return false;
  const at = `/files/${i}`;
  if (typeof e.path !== "string") return false;
  if (!isWireInteger(e.size, `${at}/size`, 0, nonWire)) return false;
  if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) return false;
  const b = e.blob;
  if (!isObject(b)) return false;
  if (typeof b.sha256 !== "string" || !SHA256_RE.test(b.sha256)) return false;
  if (!isWireInteger(b.bytes, `${at}/blob/bytes`, 0, nonWire)) return false;
  if (b.codec === "none") {
    if (b.bytes !== e.size || b.sha256 !== e.sha256) return false;
  } else if (b.codec !== "zstd") return false;
  if (container && !isWireInteger(e.offset, `${at}/offset`, 0, nonWire))
    return false;
  return true;
}

/**
 * `parseFilesIndex(stored, ref, variant)` (plans/P4-01.md §2.7): the first failure, in order:
 *
 *  1. `ref.size` above the limit (checked before anything is decoded), the stored SHA-256 or
 *     length differs from the ref, the decode fails, or the decoded length is not `ref.size`
 *     → `files-index-invalid`;
 *  2. strict JSON or the integer rule → `files-index-invalid`;
 *  3. `format`, `layout` (the ref's), `payload` (the variant's), `files` and the entry member
 *     rules → `files-index-invalid`;
 *  4. the path rules in index order → `files-unsafe-path`, `files-duplicate-path`,
 *     `files-case-collision` or `files-path-conflict`, with `path`;
 *  5. a container that breaks the layout rule → `files-layout-mismatch`; a tree whose paths
 *     are not strictly ascending, whose sizes do not sum to `payload.size`, or whose
 *     `treeDigest` differs from `payload.sha256` → `files-index-invalid`.
 *
 * Never throws.
 */
export async function parseFilesIndex(
  stored: Uint8Array,
  ref: FilesIndexRef,
  variant: { payload: { size: number; sha256: string } },
  opts: ParseFilesIndexOptions = {},
): Promise<ParseFilesIndexResult> {
  try {
    // 1. The stored object against its ref, then the decode.
    const max = opts.maxBytes ?? MAX_FILES_INDEX_BYTES;
    if (typeof ref.size !== "number" || ref.size > max) return invalid;
    if (stored.byteLength !== ref.bytes) return invalid;
    if ((await sha256Hex(stored)) !== ref.sha256) return invalid;
    let decoded: Uint8Array;
    if (ref.codec === "none") decoded = stored;
    else if (ref.codec === "zstd" && opts.decode) {
      try {
        decoded = await opts.decode(stored, ref.size);
      } catch {
        return invalid;
      }
    } else return invalid;
    if (!(decoded instanceof Uint8Array) || decoded.byteLength !== ref.size)
      return invalid;

    // 2. Strict JSON; the integer rule runs with the member rules.
    const parsed = strictParse(decoded);
    if (parsed === null) return invalid;
    const { value: doc, nonWire } = parsed;

    // 3. The member rules.
    if (!isObject(doc)) return invalid;
    if (doc.format !== FILES_FORMAT || doc.layout !== ref.layout)
      return invalid;
    const p = doc.payload;
    if (!isObject(p)) return invalid;
    if (!isWireInteger(p.size, "/payload/size", 0, nonWire)) return invalid;
    if (typeof p.sha256 !== "string" || !SHA256_RE.test(p.sha256))
      return invalid;
    if (p.size !== variant.payload.size || p.sha256 !== variant.payload.sha256)
      return invalid;
    const files = doc.files;
    if (!Array.isArray(files) || files.length > MAX_INDEX_FILES) return invalid;
    const container = doc.layout === "container";
    for (const [i, e] of files.entries())
      if (!entryOk(e, i, container, nonWire)) return invalid;
    const entries = files as FilesIndexEntry[];

    // 4. The path rules.
    const paths = checkPaths(entries.map((e) => e.path));
    if (!paths.ok) return { ok: false, error: paths.error, path: paths.path };

    // 5. The layout.
    const total = entries.reduce((a, e) => a + e.size, 0);
    if (container) {
      let end = 0;
      for (const e of entries) {
        const offset = e.offset as number;
        if (offset < end) return { ok: false, error: "files-layout-mismatch" };
        end = offset + e.size;
      }
      if (end > p.size) return { ok: false, error: "files-layout-mismatch" };
      const gaps = ref.gaps;
      if (!gaps || !has(gaps as Record<string, unknown>, "size"))
        return { ok: false, error: "files-layout-mismatch" };
      if (p.size - total !== gaps.size)
        return { ok: false, error: "files-layout-mismatch" };
    } else if (doc.layout === "tree") {
      for (let i = 1; i < entries.length; i++)
        if (compareBytes(entries[i - 1]!.path, entries[i]!.path) >= 0)
          return invalid;
      if (total !== p.size) return invalid;
      if ((await treeDigest(entries)) !== p.sha256) return invalid;
    }
    return { ok: true, index: doc as unknown as FilesIndexDoc };
  } catch {
    return invalid;
  }
}
