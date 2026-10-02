// The appliers (plans/P4-01.md §2.9; notes/A7 §3.4): `applyFull`, `applyDelta` and `applyFile`,
// over injected ports. `content/cases.json#applyCases` pins every verdict and counter. The first
// failure is the verdict, and nothing throws: a port that throws is the failing step's code.
//
// Verify before use: a stored object's length and SHA-256 are checked against its ref before a
// byte is decoded, an installed base's SHA-256 against the delta's `from` before it is used, and
// the output's SHA-256 before it is reported. Every `zstd-patch-from` frame passes §2.7 rule 3's
// window check (`windowAllowed`, with the decoder's own P) before it is decoded, whichever
// decoder the host injected, and a base that starts with the zstd dictionary magic is refused
// (rule 5: CI never publishes one; an auto-detecting decoder would misread it).

import type {
  FilesDelta,
  FilesIndexDoc,
  FilesIndexEntry,
  PackVariant,
  PatchEntry,
  PayloadDelta,
} from "@polaris-key/protocol/packs";
import { MAX_FILES_INDEX_BYTES } from "@polaris-key/protocol/core";
import { parseFilesIndex, treeDigest, type FilesErrorCode } from "./files.js";
import { openObject, parsePatch } from "./patch.js";
import {
  READ_CHUNK,
  hashSource,
  memorySource,
  readAll,
  sha256Of,
  sliceSource,
  webCryptoSha256,
  type ByteSink,
  type ByteSource,
  type InstalledFile,
  type ObjectPort,
  type Sha256Port,
  type TreeSink,
  type ZstdPort,
} from "./ports.js";
import { usableCodec } from "./select.js";
import { windowAllowed, windowLogMax } from "./window.js";

/** Every code an applier returns (`conformance/parity/errors.json`). */
export type ApplyErrorCode =
  | FilesErrorCode
  | "full-corrupt"
  | "delta-artifact-mismatch"
  | "delta-base-mismatch"
  | "delta-apply-failed"
  | "file-corrupt"
  | "file-source-missing"
  | "payload-hash-mismatch";

export interface ApplyFailure {
  ok: false;
  error: ApplyErrorCode;
  path?: string;
}

/** The counters of the `file` strategy and of a `files` set (§2.9). */
export interface ApplyCounters {
  reusedFiles: number;
  deltaFiles: number;
  blobFiles: number;
  /** The bytes of the objects fetched for the strategy, except the index and gaps. */
  downloadedBytes: number;
}

/** A rebuilt container: its payload hash and size. */
export interface ContainerVerdict {
  ok: true;
  sha256: string;
  size: number;
}

/** A rebuilt tree: its file count, total size and `treeDigest`. */
export interface TreeVerdict {
  ok: true;
  files: number;
  bytes: number;
  treeDigest: string;
}

export type ApplyVerdict =
  | ContainerVerdict
  | TreeVerdict
  | (ContainerVerdict & ApplyCounters)
  | (TreeVerdict & ApplyCounters)
  | ApplyFailure;

/** An applier's answer: the verdict, and the target index when one was read. */
export interface ApplyResult {
  verdict: ApplyVerdict;
  index?: FilesIndexDoc;
}

export interface ApplyPorts {
  /** The stored objects the strategy fetched, by the SHA-256 of their stored bytes. */
  objects: ObjectPort;
  zstd: ZstdPort;
  /** Default: WebCrypto over buffered input. */
  sha256?: Sha256Port;
  /** Where a container payload is written (offset 0 onward). Omitted: discarded. */
  sink?: ByteSink;
  /** Where a tree's files are written. Omitted: discarded. */
  tree?: TreeSink;
}

const fail = (error: ApplyErrorCode, path?: string): ApplyResult => ({
  verdict:
    path === undefined ? { ok: false, error } : { ok: false, error, path },
});

const DICTIONARY_MAGIC = [0x37, 0xa4, 0x30, 0xec];

function startsWithDictionaryMagic(b: Uint8Array): boolean {
  return b.byteLength >= 4 && DICTIONARY_MAGIC.every((m, i) => b[i] === m);
}

/** One raw-prefix decode behind the window check (§2.7 rules 3 and 5). Null on refusal. */
async function prefixDecode(
  zstd: ZstdPort,
  frame: Uint8Array,
  base: Uint8Array,
  size: number,
  memBytes: number,
): Promise<Uint8Array | null> {
  if (startsWithDictionaryMagic(base)) return null;
  const wlm = windowLogMax(memBytes, zstd.pointerBits);
  if (wlm === null || !windowAllowed(frame, memBytes, zstd.pointerBits))
    return null;
  try {
    const out = await zstd.decodeWithPrefix(frame, base, size, wlm);
    return out instanceof Uint8Array ? out : null;
  } catch {
    return null;
  }
}

/** Read and parse the target index (§2.7), refusing an oversized one before reading it. */
async function readIndex(
  variant: PackVariant,
  ports: ApplyPorts,
): Promise<
  | { ok: true; index: FilesIndexDoc }
  | { ok: false; error: FilesErrorCode; path?: string }
> {
  const files = variant.files;
  let stored: Uint8Array = new Uint8Array();
  if (typeof files.size === "number" && files.size <= MAX_FILES_INDEX_BYTES) {
    const src = await ports.objects(files.sha256).catch(() => null);
    if (src !== null && src.size === files.bytes) stored = await readAll(src);
  }
  return parseFilesIndex(stored, files, variant, {
    decode: (frame, size) => ports.zstd.decode(frame, size),
  });
}

/** Write a source's bytes to a sink at `at`, feeding a hasher; returns the bytes written. */
async function copyThrough(
  source: ByteSource,
  sink: ByteSink | undefined,
  at: number,
  hasher: { update(b: Uint8Array): void },
): Promise<number> {
  let n = 0;
  while (n < source.size) {
    const chunk = await source.read(n, Math.min(READ_CHUNK, source.size - n));
    if (chunk.byteLength === 0) break;
    hasher.update(chunk);
    if (sink) await sink.write(at + n, chunk);
    n += chunk.byteLength;
  }
  return n;
}

/**
 * `applyFull` (§2.9): a tree first validates its index (§2.7's codes). Then, before decoding,
 * the `full` ref must be usable with `full.size === payload.size`, and the stored length and
 * SHA-256 must equal the ref → else `full-corrupt`; the decode must give exactly `full.size`
 * bytes → `full-corrupt`. A container's bytes must hash to `payload.sha256`; a tree's are split
 * by entry sizes in index order and every file's SHA-256 checked → `full-corrupt`.
 */
export async function applyFull(
  variant: PackVariant,
  ports: ApplyPorts,
): Promise<ApplyResult> {
  try {
    const sha256 = ports.sha256 ?? webCryptoSha256;
    const payload = variant.payload;
    const full = variant.full;
    let index: FilesIndexDoc | null = null;
    if (variant.files.layout === "tree") {
      const r = await readIndex(variant, ports);
      if (!r.ok) return { verdict: r };
      index = r.index;
    }
    if (!usableCodec(full.codec) || full.size !== payload.size)
      return fail("full-corrupt");
    const stored = await ports.objects(full.sha256).catch(() => null);
    if (stored === null || stored.size !== full.bytes)
      return fail("full-corrupt");

    // Stream the decode when the port can, so a large payload never sits in one buffer.
    if (full.codec === "zstd" && ports.zstd.decodeStream) {
      if ((await hashSource(sha256, stored)) !== full.sha256)
        return fail("full-corrupt");
      return await streamFull(variant, index, stored, ports, sha256);
    }

    const out = await openObject(stored, full, { zstd: ports.zstd, sha256 });
    if (out === null) return fail("full-corrupt");
    if (index === null) {
      if ((await sha256Of(sha256, out)) !== payload.sha256)
        return fail("full-corrupt");
      if (ports.sink) await ports.sink.write(0, out);
      return {
        verdict: { ok: true, sha256: payload.sha256, size: out.byteLength },
      };
    }
    let pos = 0;
    for (const f of index.files) {
      const part = out.subarray(pos, pos + f.size);
      pos += f.size;
      if (
        part.byteLength !== f.size ||
        (await sha256Of(sha256, part)) !== f.sha256
      )
        return fail("full-corrupt");
      if (ports.tree) await ports.tree.writeFile(f.path, part);
    }
    return {
      verdict: {
        ok: true,
        files: index.files.length,
        bytes: out.byteLength,
        treeDigest: await treeDigest(index.files),
      },
      index,
    };
  } catch {
    return fail("full-corrupt");
  }
}

/** `applyFull`'s streaming path: the frame's output arrives in order and is hashed (a
 *  container) or split into files (a tree) as it comes. */
async function streamFull(
  variant: PackVariant,
  index: FilesIndexDoc | null,
  stored: ByteSource,
  ports: ApplyPorts,
  sha256: Sha256Port,
): Promise<ApplyResult> {
  const payload = variant.payload;
  const size = variant.full.size;
  let total = 0;
  if (index === null) {
    const hasher = sha256();
    try {
      await ports.zstd.decodeStream!(stored, size, async (chunk) => {
        if (total + chunk.byteLength > size) throw new Error("overrun");
        hasher.update(chunk);
        if (ports.sink) await ports.sink.write(total, chunk);
        total += chunk.byteLength;
      });
    } catch {
      return fail("full-corrupt");
    }
    if (total !== size || (await hasher.digest()) !== payload.sha256)
      return fail("full-corrupt");
    return { verdict: { ok: true, sha256: payload.sha256, size } };
  }
  // A tree: walk the entries as the bytes arrive; each file is buffered alone.
  const files = index.files;
  let i = 0;
  let parts: Uint8Array[] = [];
  let have = 0;
  let bad = false;
  const flush = async (): Promise<void> => {
    while (i < files.length && have >= files[i]!.size) {
      const f = files[i]!;
      const buf = new Uint8Array(f.size);
      let at = 0;
      const rest: Uint8Array[] = [];
      for (const p of parts) {
        const take = Math.min(p.byteLength, f.size - at);
        buf.set(p.subarray(0, take), at);
        at += take;
        if (take < p.byteLength) rest.push(p.subarray(take));
      }
      parts = rest;
      have -= f.size;
      if ((await sha256Of(sha256, buf)) !== f.sha256) {
        bad = true;
        throw new Error("file hash");
      }
      if (ports.tree) await ports.tree.writeFile(f.path, buf);
      i++;
    }
  };
  try {
    await flush(); // zero-size files at the start
    await ports.zstd.decodeStream!(stored, size, async (chunk) => {
      if (total + chunk.byteLength > size) throw new Error("overrun");
      total += chunk.byteLength;
      parts.push(chunk.slice());
      have += chunk.byteLength;
      await flush();
    });
  } catch {
    return fail("full-corrupt");
  }
  if (bad || total !== size || i !== files.length) return fail("full-corrupt");
  return {
    verdict: {
      ok: true,
      files: files.length,
      bytes: total,
      treeDigest: await treeDigest(files),
    },
    index,
  };
}

/** `applyDelta`'s options. `skipBaseCheck` is the corpus's test-only switch. */
export interface ApplyDeltaOptions extends ApplyPorts {
  skipBaseCheck?: boolean;
}

/**
 * `applyDelta` (`payload` scope, §2.9): the artifact against its ref → `delta-artifact-mismatch`;
 * the base's SHA-256 equals `from` → `delta-base-mismatch`; §2.7 rule 3's window check, then the
 * raw-prefix decode, its length and its SHA-256 against `payload` → `delta-apply-failed`.
 */
export async function applyDelta(
  variant: PackVariant,
  deltaIndex: number,
  base: ByteSource,
  opts: ApplyDeltaOptions,
): Promise<ApplyResult> {
  try {
    const sha256 = opts.sha256 ?? webCryptoSha256;
    const payload = variant.payload;
    const d = (variant.deltas ?? [])[deltaIndex] as PayloadDelta | undefined;
    if (!d || d.scope !== "payload") return fail("delta-artifact-mismatch");
    const a = d.artifact;
    const src = await opts.objects(a.sha256).catch(() => null);
    if (src === null || src.size !== a.bytes)
      return fail("delta-artifact-mismatch");
    const frame = await readAll(src);
    if (
      frame.byteLength !== a.bytes ||
      (await sha256Of(sha256, frame)) !== a.sha256
    )
      return fail("delta-artifact-mismatch");
    const baseBytes = await readAll(base);
    if (!opts.skipBaseCheck && (await sha256Of(sha256, baseBytes)) !== d.from)
      return fail("delta-base-mismatch");
    const out = await prefixDecode(
      opts.zstd,
      frame,
      baseBytes,
      payload.size,
      d.memBytes,
    );
    if (
      out === null ||
      out.byteLength !== payload.size ||
      (await sha256Of(sha256, out)) !== payload.sha256
    )
      return fail("delta-apply-failed");
    if (opts.sink) await opts.sink.write(0, out);
    return {
      verdict: { ok: true, sha256: payload.sha256, size: out.byteLength },
    };
  } catch {
    return fail("delta-apply-failed");
  }
}

/**
 * `applyFile` (§2.9), for the `file` strategy (`deltaIndex` null) and for a `files`-scope set:
 * the target index (§2.7's codes), the gaps ref of a container (a failure is
 * `files-layout-mismatch`), the descriptor and data of a set (`delta-artifact-mismatch`). Then
 * for each target file in index order: reuse an installed file with the same SHA-256; else the
 * set's `delta` entry (no installed file with its `from` → `delta-base-mismatch {path}`; the
 * window check against the set's `memBytes`, then the decode → `delta-apply-failed {path}`);
 * else its `blob` entry, or for the `file` strategy the file's own blob by its ref (ref, decode
 * or hash → `file-corrupt {path}`); else `file-source-missing {path}`. A container's payload
 * SHA-256 → `payload-hash-mismatch`; a tree checks every file, reused ones included
 * (`file-corrupt {path}`), and reports its `treeDigest`. Reused files are not re-hashed on a
 * container's fast path: the payload hash covers them.
 */
export async function applyFile(
  variant: PackVariant,
  deltaIndex: number | null,
  installed: Iterable<InstalledFile>,
  ports: ApplyPorts,
): Promise<ApplyResult> {
  const sha256 = ports.sha256 ?? webCryptoSha256;
  let current: { error: ApplyErrorCode; path?: string } = {
    error: "file-corrupt",
  };
  try {
    const payload = variant.payload;
    const r = await readIndex(variant, ports);
    if (!r.ok) return { verdict: r };
    const index = r.index;
    const container = index.layout === "container";

    let gaps: Uint8Array | null = null;
    if (container) {
      const g = variant.files.gaps!;
      const src = await ports.objects(g.sha256).catch(() => null);
      gaps = await openObject(src, g, { zstd: ports.zstd, sha256 });
      if (gaps === null) return fail("files-layout-mismatch");
    }

    let entries = new Map<string, PatchEntry>();
    let data: ByteSource | null = null;
    let memBytes = 0;
    let downloaded = 0;
    let usingSet = false;
    if (deltaIndex !== null) {
      const d = (variant.deltas ?? [])[deltaIndex] as FilesDelta | undefined;
      if (!d || d.scope !== "files") return fail("delta-artifact-mismatch");
      usingSet = true;
      memBytes = d.memBytes;
      const patchSrc = await ports.objects(d.patch.sha256).catch(() => null);
      const patch = await parsePatch(patchSrc, d, payload.sha256, index, {
        zstd: ports.zstd,
        sha256,
      });
      if (patch === null) return fail("delta-artifact-mismatch");
      data = await ports.objects(d.data.sha256).catch(() => null);
      if (
        data === null ||
        data.size !== d.data.bytes ||
        (await hashSource(sha256, data)) !== d.data.sha256
      )
        return fail("delta-artifact-mismatch");
      downloaded = d.patch.bytes + d.data.bytes;
      entries = new Map(patch.entries.map((e) => [e.path, e]));
    }

    const have = new Map<string, InstalledFile>();
    for (const f of installed) if (!have.has(f.sha256)) have.set(f.sha256, f);
    const counters = { reusedFiles: 0, deltaFiles: 0, blobFiles: 0 };

    // A container is written as it is rebuilt (gap, file, gap, …) and hashed whole; a tree's
    // produced files are written at once, its reused ones after the second pass verifies them.
    const hasher = sha256();
    let pos = 0;
    let gp = 0;
    let written = 0;
    const reused: (InstalledFile | null)[] = [];

    for (const f of index.files) {
      current = { error: "file-corrupt", path: f.path };
      const reuse = have.get(f.sha256);
      let bytes: Uint8Array | null = null;
      if (reuse) {
        counters.reusedFiles++;
      } else if (usingSet) {
        const e = entries.get(f.path);
        if (!e) return fail("file-source-missing", f.path);
        const slice = await data!.read(e.offset, e.length);
        if (e.op === "delta") {
          current = { error: "delta-apply-failed", path: f.path };
          const b = have.get(e.from!);
          if (!b) return fail("delta-base-mismatch", f.path);
          const baseBytes = await readAll(b.source);
          if ((await sha256Of(sha256, baseBytes)) !== e.from)
            return fail("delta-base-mismatch", f.path);
          const out = await prefixDecode(
            ports.zstd,
            slice,
            baseBytes,
            f.size,
            memBytes,
          );
          if (
            out === null ||
            out.byteLength !== f.size ||
            (await sha256Of(sha256, out)) !== f.sha256
          )
            return fail("delta-apply-failed", f.path);
          bytes = out;
          counters.deltaFiles++;
        } else {
          let out: Uint8Array | null = slice;
          if (e.codec === "zstd") {
            try {
              out = await ports.zstd.decode(slice, f.size);
            } catch {
              out = null;
            }
          }
          if (
            !(out instanceof Uint8Array) ||
            out.byteLength !== f.size ||
            (await sha256Of(sha256, out)) !== f.sha256
          )
            return fail("file-corrupt", f.path);
          bytes = out;
          counters.blobFiles++;
        }
      } else {
        const stored = await ports.objects(f.blob.sha256).catch(() => null);
        if (stored === null) return fail("file-source-missing", f.path);
        const out = await openObject(
          stored,
          { ...f.blob, size: f.size },
          { zstd: ports.zstd, sha256 },
        );
        if (out === null || (await sha256Of(sha256, out)) !== f.sha256)
          return fail("file-corrupt", f.path);
        bytes = out;
        counters.blobFiles++;
        downloaded += stored.size;
      }

      if (container) {
        const g = (f.offset as number) - pos;
        const gap = gaps!.subarray(gp, gp + g);
        hasher.update(gap);
        if (ports.sink) await ports.sink.write(written, gap);
        written += gap.byteLength;
        gp += g;
        const src = bytes !== null ? memorySource(bytes) : reuse!.source;
        written += await copyThrough(
          sliceSource(src, 0, f.size),
          ports.sink,
          written,
          hasher,
        );
        pos = (f.offset as number) + f.size;
      } else {
        if (bytes !== null && ports.tree)
          await ports.tree.writeFile(f.path, bytes);
        reused.push(bytes === null ? reuse! : null);
      }
    }

    const tail = { ...counters, downloadedBytes: downloaded };
    if (!container) {
      for (const [i, f] of index.files.entries()) {
        const r = reused[i];
        if (!r) continue;
        const bytes = await readAll(sliceSource(r.source, 0, f.size));
        if (
          bytes.byteLength !== f.size ||
          (await sha256Of(sha256, bytes)) !== f.sha256
        )
          return fail("file-corrupt", f.path);
        if (ports.tree) await ports.tree.writeFile(f.path, bytes);
      }
      return {
        verdict: {
          ok: true,
          files: index.files.length,
          bytes: index.files.reduce((a, f: FilesIndexEntry) => a + f.size, 0),
          treeDigest: await treeDigest(index.files),
          ...tail,
        },
        index,
      };
    }
    const trailing = gaps!.subarray(gp);
    hasher.update(trailing);
    if (ports.sink) await ports.sink.write(written, trailing);
    written += trailing.byteLength;
    if ((await hasher.digest()) !== payload.sha256)
      return fail("payload-hash-mismatch");
    return {
      verdict: { ok: true, sha256: payload.sha256, size: written, ...tail },
      index,
    };
  } catch {
    return fail(current.error, current.path);
  }
}
