/**
 * A pack variant's patch artifacts (P4-03; plans/P4-01.md §2.3, §2.7; notes/A7 §3.2–§3.3).
 *
 * From one payload — a stripped PCK (`layout: container`) or a directory (`layout: tree`) — this
 * builds every object the record and its side objects name:
 *
 *   - `full`: the whole payload (a tree's files concatenated in index order), one zstd frame;
 *   - the `pkey-files/1` index, one zstd frame, each entry carrying its file's blob reference;
 *   - for a container, the gaps object: every byte no entry covers, in order, one zstd frame;
 *   - one blob per file, deduplicated by content hash;
 *   - against each proven base: a whole-payload `zstd --patch-from` frame (containers only) and a
 *     packed `files` set (a `pkey-patch/1` descriptor plus one data object).
 *
 * Every compressed object is one zstd frame with its content size, stored raw (`codec: none`)
 * when the frame is not smaller (§2.7 rule 1). Frames come from the zstd CLI (`zstd -19`,
 * `zstd -19 --patch-from=<base>`), the tool every A6/A7 vector was built with; it must be
 * ≥ 1.5.5. Compressed bytes may differ across zstd versions, which content addressing makes
 * harmless.
 *
 * Self-checks before anything is published: the stored index passes client-core's
 * `parseFilesIndex` under `MAX_PUBLISHED_INDEX_BYTES` (the CLI never publishes a larger one,
 * decision 36); the stored gaps and file blobs, decoded, rebuild the payload byte for byte; the
 * stored `full` decodes to the payload; every delta frame decodes against its base to its
 * target and passes the window check (`windowAllowed`, §2.7 rule 3); and no
 * `zstd-patch-from` frame is ever built against a base that starts with the zstd dictionary
 * magic `37 A4 30 EC` (rule 5: skipped and reported).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { FILES_FORMAT, PATCH_FORMAT } from "@polaris-key/protocol/core";
import {
  ZSTD_DICTIONARY_MAGIC,
  type FilesIndexDoc,
  type FilesIndexEntry,
  type ObjectRef,
  type PatchDoc,
  type PatchEntry,
} from "@polaris-key/protocol/packs";
import {
  parseFilesIndex,
  treeDigest,
  windowAllowed,
} from "@polaris-key/client-core/packs";
import { MAX_PUBLISHED_INDEX_BYTES } from "@polaris-key/manifest";
import type { PckDirectory } from "./pck.js";

export const PATCH_METHOD = "zstd-patch-from";
/** The zstd level every object is compressed at (A7's vectors). */
export const ZSTD_LEVEL = 19;
/** The oldest zstd CLI the publish accepts. */
export const MIN_ZSTD_VERSION = "1.5.5";

export function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** UTF-8 byte order (equal to code-point order), the order of tree indexes and `treeDigest`. */
export function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

export function startsWithDictMagic(b: Uint8Array): boolean {
  return (
    b.byteLength >= 4 &&
    Buffer.from(b.subarray(0, 4)).toString("hex") === ZSTD_DICTIONARY_MAGIC
  );
}

// ── The zstd CLI ─────────────────────────────────────────────────────────────

export interface Zstd {
  /** `zstd -V`'s version, e.g. `1.5.7`. */
  readonly version: string;
  /** One frame per input (`zstd -19`, from files, so each frame carries its content size). */
  compressMany(inputs: readonly Uint8Array[]): Uint8Array[];
  /** A bare `zstd -19 --patch-from=<base> <target>` frame. */
  patchFrom(base: Uint8Array, target: Uint8Array): Uint8Array;
  /** Decode frames (`zstd -d`). */
  decodeMany(frames: readonly Uint8Array[]): Uint8Array[];
  /** Decode a `--patch-from` frame against its base (`zstd -d --patch-from=<base>`). */
  decodePatch(frame: Uint8Array, base: Uint8Array): Uint8Array;
}

/** `v` ≥ `min`, both `major.minor.patch`. */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split(".").map(Number);
  const b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Arguments per zstd process, so a 20,000-file pack never meets the OS's argument limit. */
const FILES_PER_PROCESS = 400;

/**
 * The zstd CLI, working in `workDir`. Throws unless `zstd` is on PATH at ≥ 1.5.5 (the Action
 * installs it).
 */
export function zstdCli(workDir: string, bin = "zstd"): Zstd {
  let out: string;
  try {
    out = execFileSync(bin, ["-V"], { encoding: "utf8" });
  } catch {
    throw new Error(
      `The zstd CLI is not on PATH; pkey release publish needs zstd ≥ ${MIN_ZSTD_VERSION} to build a pack's objects (apt-get install zstd, brew install zstd).`,
    );
  }
  const m = /v(\d+\.\d+\.\d+)/.exec(out);
  if (!m || !versionAtLeast(m[1]!, MIN_ZSTD_VERSION))
    throw new Error(
      `pkey release publish needs zstd ≥ ${MIN_ZSTD_VERSION}; \`zstd -V\` says ${out.trim()}.`,
    );
  const version = m[1]!;
  let n = 0;
  const run = (args: string[]): void => {
    execFileSync(bin, ["-q", "-f", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  };
  const fresh = (label: string): string => {
    const d = path.join(workDir, `${label}${n++}`);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const many = (
    inputs: readonly Uint8Array[],
    args: string[],
    inExt: string,
    outExt: string,
  ): Uint8Array[] => {
    const results: Uint8Array[] = [];
    for (let s = 0; s < inputs.length; s += FILES_PER_PROCESS) {
      const slice = inputs.slice(s, s + FILES_PER_PROCESS);
      const inDir = fresh("in");
      const outDir = fresh("out");
      const names = slice.map((b, i) => {
        const f = path.join(inDir, `${i}${inExt}`);
        writeFileSync(f, b);
        return f;
      });
      run([...args, "--output-dir-flat", outDir, ...names]);
      for (const i of slice.keys())
        results.push(
          new Uint8Array(readFileSync(path.join(outDir, `${i}${outExt}`))),
        );
    }
    return results;
  };
  return {
    version,
    compressMany: (inputs) => many(inputs, [`-${ZSTD_LEVEL}`], "", ".zst"),
    decodeMany: (frames) => many(frames, ["-d", "--long=31"], ".zst", ""),
    patchFrom(base, target) {
      const d = fresh("pf");
      const b = path.join(d, "base");
      const t = path.join(d, "target");
      const o = path.join(d, "out.zst");
      writeFileSync(b, base);
      writeFileSync(t, target);
      run([`-${ZSTD_LEVEL}`, `--patch-from=${b}`, t, "-o", o]);
      return new Uint8Array(readFileSync(o));
    },
    decodePatch(frame, base) {
      const d = fresh("dp");
      const b = path.join(d, "base");
      const f = path.join(d, "in.zst");
      const o = path.join(d, "out");
      writeFileSync(b, base);
      writeFileSync(f, frame);
      run(["-d", "--long=31", `--patch-from=${b}`, f, "-o", o]);
      return new Uint8Array(readFileSync(o));
    },
  };
}

// ── Stored objects ───────────────────────────────────────────────────────────

export interface Stored {
  ref: ObjectRef;
  /** The stored bytes (what the blob store holds under `ref.sha256`). */
  stored: Uint8Array;
}

/** §2.7 rule 1 for each input: one zstd frame, or raw when the frame is not smaller. */
export function storeMany(z: Zstd, datas: readonly Uint8Array[]): Stored[] {
  const frames = z.compressMany(datas);
  return datas.map((data, i) => {
    const frame = frames[i]!;
    const zstd = frame.byteLength < data.byteLength;
    const stored = zstd ? frame : data;
    return {
      ref: {
        sha256: sha256Hex(stored),
        bytes: stored.byteLength,
        size: data.byteLength,
        codec: zstd ? "zstd" : "none",
      },
      stored,
    };
  });
}

// ── Payloads ─────────────────────────────────────────────────────────────────

export interface PayloadFile {
  path: string;
  /** Absolute offset in a container payload; absent in a tree. */
  offset?: number;
  size: number;
  sha256: string;
  data: Uint8Array;
}

export type Payload =
  | { layout: "container"; bytes: Uint8Array; files: PayloadFile[] }
  | { layout: "tree"; files: PayloadFile[] };

/**
 * A stripped PCK as a container payload: its entries in non-decreasing offset order (a zero-size
 * entry before a sized one at the same offset), each starting at or after the end of the one
 * before. An overlap cannot be indexed and is refused.
 */
export function containerPayload(
  bytes: Uint8Array,
  dir: PckDirectory,
): Payload {
  const files = dir.entries
    .map((e) => {
      const data = bytes.subarray(e.offset, e.offset + e.size);
      return {
        path: e.path,
        offset: e.offset,
        size: e.size,
        sha256: sha256Hex(data),
        data,
      };
    })
    .sort((a, b) => a.offset - b.offset || a.size - b.size);
  let end = 0;
  for (const f of files) {
    if (f.offset < end)
      throw new Error(
        `${f.path}: its bytes overlap the entry before it; a files index cannot describe this PCK.`,
      );
    end = f.offset + f.size;
  }
  return { layout: "container", bytes, files };
}

export interface TreeRead {
  files: PayloadFile[];
  /** Symbolic links and other non-regular files, by path: lint failures. */
  errors: string[];
}

/**
 * A directory as a tree payload: every regular file under `root`, by `/`-separated path, sorted
 * by path bytes, without the top-level `.pkey/` directory (where the tree's marker lives, which
 * no files index lists). A symbolic link or another non-regular file is an error with its path.
 */
export async function readTree(root: string): Promise<TreeRead> {
  const files: PayloadFile[] = [];
  const errors: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!prefix && e.name === ".pkey") continue;
      const full = path.join(dir, e.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        errors.push(
          `${rel}: a symbolic link; a tree pack holds regular files only.`,
        );
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, rel);
        continue;
      }
      if (!st.isFile()) {
        errors.push(`${rel}: not a regular file.`);
        continue;
      }
      const data = new Uint8Array(await readFile(full));
      files.push({
        path: rel,
        size: data.byteLength,
        sha256: sha256Hex(data),
        data,
      });
    }
  }
  try {
    await walk(root, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${root} does not exist.`);
    throw e;
  }
  files.sort((a, b) => compareBytes(a.path, b.path));
  return { files, errors };
}

/** The variant's `payload`: a container's file SHA-256, a tree's `treeDigest` (§2.7). */
export async function payloadIdentity(
  p: Payload,
): Promise<{ size: number; sha256: string }> {
  if (p.layout === "container")
    return { size: p.bytes.byteLength, sha256: sha256Hex(p.bytes) };
  return {
    size: p.files.reduce((a, f) => a + f.size, 0),
    sha256: await treeDigest(p.files),
  };
}

/** A container's uncovered bytes, in order (gap₀, gap₁, …, the tail). */
export function gapsOf(
  bytes: Uint8Array,
  files: readonly PayloadFile[],
): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const f of files) {
    parts.push(bytes.subarray(pos, f.offset!));
    pos = f.offset! + f.size;
  }
  parts.push(bytes.subarray(pos));
  return concat(parts);
}

/** The bytes `full` holds: a container's payload, a tree's files concatenated in index order. */
export function fullBytesOf(p: Payload): Uint8Array {
  return p.layout === "container"
    ? p.bytes
    : concat(p.files.map((f) => f.data));
}

// ── One variant's objects ────────────────────────────────────────────────────

export interface BuiltPayload {
  payload: { size: number; sha256: string };
  layout: "container" | "tree";
  full: Stored;
  index: FilesIndexDoc;
  /** The record's `files` member (without `gaps`, which is `gaps` below). */
  indexStored: Stored;
  gaps?: Stored;
  /** File blobs by the file's SHA-256. */
  blobs: Map<string, Stored>;
  files: PayloadFile[];
}

/**
 * Build `full`, the files index, the gaps object and every file blob for one payload. Throws
 * when the index would exceed `MAX_PUBLISHED_INDEX_BYTES` (decision 36).
 */
export async function buildPayload(z: Zstd, p: Payload): Promise<BuiltPayload> {
  const payload = await payloadIdentity(p);
  // One blob per distinct file content.
  const distinct = new Map<string, PayloadFile>();
  for (const f of p.files)
    if (!distinct.has(f.sha256)) distinct.set(f.sha256, f);
  const list = [...distinct.values()];
  const gapBytes = p.layout === "container" ? gapsOf(p.bytes, p.files) : null;
  const fullBytes = fullBytesOf(p);
  const stored = storeMany(z, [
    fullBytes,
    ...(gapBytes ? [gapBytes] : []),
    ...list.map((f) => f.data),
  ]);
  const full = stored[0]!;
  const gaps = gapBytes ? stored[1]! : undefined;
  const blobs = new Map<string, Stored>();
  list.forEach((f, i) => blobs.set(f.sha256, stored[(gapBytes ? 2 : 1) + i]!));
  const index: FilesIndexDoc = {
    format: FILES_FORMAT,
    layout: p.layout,
    payload,
    files: p.files.map((f): FilesIndexEntry => {
      const b = blobs.get(f.sha256)!.ref;
      return {
        path: f.path,
        ...(p.layout === "container" ? { offset: f.offset! } : {}),
        size: f.size,
        sha256: f.sha256,
        blob: { sha256: b.sha256, bytes: b.bytes, codec: b.codec },
      };
    }),
  };
  const indexJson = new TextEncoder().encode(JSON.stringify(index));
  if (indexJson.byteLength > MAX_PUBLISHED_INDEX_BYTES)
    throw new Error(
      `The files index is ${indexJson.byteLength} bytes (${p.files.length} files); Polaris Key reads at most ${MAX_PUBLISHED_INDEX_BYTES} per index (plans/P4-01.md decision 36). Split the pack.`,
    );
  const [indexStored] = storeMany(z, [indexJson]);
  return {
    payload,
    layout: p.layout,
    full,
    index,
    indexStored: indexStored!,
    ...(gaps ? { gaps } : {}),
    blobs,
    files: p.files,
  };
}

/** The record's `files` member for a built payload. */
export function filesRefOf(b: BuiltPayload): ObjectRef & {
  format: string;
  layout: string;
  gaps?: ObjectRef;
} {
  return {
    format: FILES_FORMAT,
    layout: b.layout,
    ...b.indexStored.ref,
    ...(b.gaps ? { gaps: b.gaps.ref } : {}),
  };
}

/**
 * The self-check before publishing: the stored index passes `parseFilesIndex` (client-core, the
 * function ingest and every applier run) under `MAX_PUBLISHED_INDEX_BYTES`; the stored gaps and
 * file blobs, decoded, rebuild the payload byte for byte (a tree: every file's SHA-256 and the
 * `treeDigest`); and `full` decodes to the payload. Throws on the first failure.
 */
export async function selfCheckPayload(
  z: Zstd,
  b: BuiltPayload,
): Promise<void> {
  const decode = (frame: Uint8Array) => z.decodeMany([frame])[0]!;
  const parsed = await parseFilesIndex(
    b.indexStored.stored,
    { ...filesRefOf(b) },
    { payload: b.payload },
    { decode: (frame) => decode(frame), maxBytes: MAX_PUBLISHED_INDEX_BYTES },
  );
  if (!parsed.ok)
    throw new Error(
      `Self-check: the files index fails parseFilesIndex (${parsed.error}${parsed.path ? ` at ${parsed.path}` : ""}); nothing was published.`,
    );
  const open = (s: Stored, frame?: Uint8Array): Uint8Array =>
    s.ref.codec === "none" ? s.stored : frame!;
  // Decode every zstd blob in one batch, then rebuild.
  const zBlobs = [...b.blobs.values()].filter((s) => s.ref.codec === "zstd");
  const decoded = new Map<string, Uint8Array>();
  z.decodeMany(zBlobs.map((s) => s.stored)).forEach((d, i) =>
    decoded.set(zBlobs[i]!.ref.sha256, d),
  );
  const byBlob = new Map<string, Stored>();
  for (const s of b.blobs.values()) byBlob.set(s.ref.sha256, s);
  const fileBytes = (e: FilesIndexEntry): Uint8Array => {
    const s = byBlob.get(e.blob.sha256);
    if (!s)
      throw new Error(`Self-check: ${e.path} names a blob pkey did not build.`);
    const data = s.ref.codec === "none" ? s.stored : decoded.get(s.ref.sha256)!;
    if (data.byteLength !== e.size || sha256Hex(data) !== e.sha256)
      throw new Error(
        `Self-check: ${e.path}'s blob does not decode to the file.`,
      );
    return data;
  };
  let rebuilt: Uint8Array;
  if (b.layout === "container") {
    const gaps = b.gaps!;
    const gapBytes = open(
      gaps,
      gaps.ref.codec === "zstd" ? decode(gaps.stored) : undefined,
    );
    const parts: Uint8Array[] = [];
    let g = 0;
    let pos = 0;
    for (const e of b.index.files) {
      const gap = e.offset! - pos;
      parts.push(gapBytes.subarray(g, g + gap));
      g += gap;
      parts.push(fileBytes(e));
      pos = e.offset! + e.size;
    }
    parts.push(gapBytes.subarray(g));
    rebuilt = concat(parts);
    if (
      rebuilt.byteLength !== b.payload.size ||
      sha256Hex(rebuilt) !== b.payload.sha256
    )
      throw new Error(
        "Self-check: the files index and the gaps object do not rebuild the payload byte for byte; nothing was published.",
      );
  } else {
    rebuilt = concat(b.index.files.map((e) => fileBytes(e)));
    if ((await treeDigest(b.index.files)) !== b.payload.sha256)
      throw new Error("Self-check: the tree's treeDigest does not match.");
  }
  const full = open(
    b.full,
    b.full.ref.codec === "zstd" ? decode(b.full.stored) : undefined,
  );
  if (
    full.byteLength !== b.full.ref.size ||
    Buffer.compare(full, rebuilt) !== 0
  )
    throw new Error(
      "Self-check: the full object does not decode to the payload.",
    );
}

// ── Deltas ───────────────────────────────────────────────────────────────────

export interface BuiltPayloadDelta {
  delta: {
    method: string;
    scope: "payload";
    from: string;
    memBytes: number;
    artifact: { sha256: string; bytes: number };
  };
  stored: Uint8Array;
}

export interface BuiltFilesDelta {
  delta: {
    method: string;
    scope: "files";
    from: string;
    memBytes: number;
    patch: ObjectRef;
    data: { sha256: string; bytes: number };
  };
  doc: PatchDoc;
  patchStored: Uint8Array;
  dataStored: Uint8Array;
  /** Entries the dictionary-magic rule turned into blob entries (paths). */
  magicBases: string[];
}

export type Skipped = { skipped: string };

/**
 * The whole-payload delta from `base` (a container's previous stripped payload) to `target`:
 * one bare `--patch-from` frame. `memBytes` is the base size plus the payload size (§2.7 rule
 * 4). Skipped, with the reason, when the base starts with the dictionary magic (rule 5), when
 * the frame is not smaller than `full`, or when the payloads are equal.
 */
export function buildPayloadDelta(
  z: Zstd,
  base: { bytes: Uint8Array; sha256: string },
  target: BuiltPayload & { layout: "container" },
  targetBytes: Uint8Array,
): BuiltPayloadDelta | Skipped {
  if (base.sha256 === target.payload.sha256)
    return { skipped: "the base is this payload" };
  if (startsWithDictMagic(base.bytes))
    return {
      skipped: `the base starts with the zstd dictionary magic 37 A4 30 EC (§2.7 rule 5)`,
    };
  const frame = z.patchFrom(base.bytes, targetBytes);
  const memBytes = base.bytes.byteLength + targetBytes.byteLength;
  if (frame.byteLength >= target.full.ref.bytes)
    return {
      skipped: `the delta (${frame.byteLength} B) is not smaller than full`,
    };
  if (!windowAllowed(frame, memBytes))
    throw new Error(
      "Self-check: a payload delta's frame window is above its memBytes limit (§2.7 rule 3).",
    );
  const back = z.decodePatch(frame, base.bytes);
  if (sha256Hex(back) !== target.payload.sha256)
    throw new Error(
      "Self-check: the payload delta does not decode to the payload.",
    );
  return {
    delta: {
      method: PATCH_METHOD,
      scope: "payload",
      from: base.sha256,
      memBytes,
      artifact: { sha256: sha256Hex(frame), bytes: frame.byteLength },
    },
    stored: frame,
  };
}

/**
 * The packed `files` set from the base's files to the target's (§2.7 `pkey-patch/1`): for every
 * target file whose hash the base lacks, in target index order, a `delta` entry (a bare
 * `--patch-from` frame against the base file at the same path) when that frame is smaller than
 * the file's blob, else a `blob` entry carrying the blob's stored bytes. Removed files vanish.
 * A base file that starts with the dictionary magic gets no frame (rule 5): its path becomes a
 * blob entry and is reported. `memBytes` is the largest base-plus-new of a delta entry, or a
 * blob entry's size. Skipped when no file changed.
 */
export function buildFilesDelta(
  z: Zstd,
  base: { sha256: string; files: readonly PayloadFile[] },
  target: BuiltPayload,
): BuiltFilesDelta | Skipped {
  if (base.sha256 === target.payload.sha256)
    return { skipped: "the base is this payload" };
  const baseHashes = new Set(base.files.map((f) => f.sha256));
  const baseByPath = new Map(base.files.map((f) => [f.path, f]));
  const entries: PatchEntry[] = [];
  const parts: Uint8Array[] = [];
  const magicBases: string[] = [];
  let off = 0;
  let mem = 0;
  const done = new Set<string>();
  for (const f of target.files) {
    if (baseHashes.has(f.sha256) || done.has(f.path)) continue;
    done.add(f.path);
    const b = baseByPath.get(f.path);
    const blob = target.blobs.get(f.sha256)!;
    let frame: Uint8Array | null = null;
    if (b) {
      if (startsWithDictMagic(b.data)) magicBases.push(f.path);
      else {
        const pf = z.patchFrom(b.data, f.data);
        if (pf.byteLength < blob.stored.byteLength) {
          if (!windowAllowed(pf, b.size + f.size))
            throw new Error(
              `Self-check: ${f.path}'s delta frame window is above its memBytes limit (§2.7 rule 3).`,
            );
          const back = z.decodePatch(pf, b.data);
          if (sha256Hex(back) !== f.sha256)
            throw new Error(
              `Self-check: ${f.path}'s delta does not decode to the file.`,
            );
          frame = pf;
        }
      }
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
  if (entries.length === 0)
    return { skipped: "no file changed against the base" };
  const data = concat(parts);
  if (data.byteLength === 0) return { skipped: "every changed file is empty" };
  const doc: PatchDoc = {
    format: PATCH_FORMAT,
    scope: "files",
    method: PATCH_METHOD,
    from: base.sha256,
    to: target.payload.sha256,
    data: { sha256: sha256Hex(data), bytes: data.byteLength },
    entries,
  };
  const [patch] = storeMany(z, [new TextEncoder().encode(JSON.stringify(doc))]);
  return {
    delta: {
      method: PATCH_METHOD,
      scope: "files",
      from: base.sha256,
      memBytes: Math.max(1, mem),
      patch: patch!.ref,
      data: { sha256: doc.data.sha256, bytes: doc.data.bytes },
    },
    doc,
    patchStored: patch!.stored,
    dataStored: data,
    magicBases,
  };
}

// ── The nondeterminism report (S-03 §4.6; warn only) ─────────────────────────

const CACHE_PATHS = new Set([
  ".godot/uid_cache.bin",
  ".godot/global_script_class_cache.cfg",
]);
/** The CI version stamp: never reported. */
const STAMP_RE = /(^|\/)(project\.binary|build[-_]info(\.[A-Za-z0-9]+)?)$/i;

/** The entries of an order-insensitive cache, in file order (S-03 `noise.py`, `cache_items`). */
export function cacheItems(p: string, b: Uint8Array): string[] | null {
  try {
    if (p.endsWith(".bin")) {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      const n = dv.getUint32(0, true);
      const out: string[] = [];
      let o = 4;
      for (let i = 0; i < n; i++) {
        const uid = dv.getBigInt64(o, true);
        const len = dv.getUint32(o + 8, true);
        out.push(
          `${uid}:${Buffer.from(b.subarray(o + 12, o + 12 + len)).toString("hex")}`,
        );
        o += 12 + len;
      }
      return o === b.byteLength ? out : null;
    }
    return [
      ...Buffer.from(b)
        .toString("latin1")
        .matchAll(/\{[^{}]*\}/g),
    ].map((m) => m[0]);
  } catch {
    return null;
  }
}

/**
 * Entries whose bytes changed against the base and look like re-import noise rather than an
 * edit: a Godot cache whose entries present in both appear in another relative order, and any
 * other entry differing in at most 8 bytes at equal length. The CI version stamp is
 * allow-listed. Never fails a publish.
 */
export function noiseReport(
  base: readonly PayloadFile[],
  target: readonly PayloadFile[],
): string[] {
  const byPath = new Map(base.map((f) => [f.path, f]));
  const out: string[] = [];
  for (const f of target) {
    const b = byPath.get(f.path);
    if (!b || b.sha256 === f.sha256 || STAMP_RE.test(f.path)) continue;
    if (CACHE_PATHS.has(f.path)) {
      const x = cacheItems(f.path, b.data);
      const y = cacheItems(f.path, f.data);
      if (!x || !y) continue;
      const sx = new Set(x);
      const sy = new Set(y);
      const keptX = x.filter((e) => sy.has(e));
      const keptY = y.filter((e) => sx.has(e));
      if (keptX.join("\n") !== keptY.join("\n"))
        out.push(
          `${f.path}: its entries were rewritten in another order${sx.size === sy.size && keptX.length === x.length ? "" : " (and grown)"} — re-import noise.`,
        );
      continue;
    }
    if (b.size === f.size) {
      let diff = 0;
      for (let i = 0; i < f.size && diff <= 8; i++)
        if (b.data[i] !== f.data[i]) diff++;
      if (diff <= 8)
        out.push(
          `${f.path}: ${diff} byte${diff === 1 ? "" : "s"} changed at equal length — likely a re-import stamp.`,
        );
    }
  }
  return out;
}
