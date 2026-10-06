/**
 * P4-03 against P4-04's content corpus: for the corpus's v1 and v2 payloads, the CLI's files
 * index and `files` descriptor have the same structure as the committed ones
 * (`conformance/corpus/v2/content/blobs/`), read through the zstd CLI. The corpus is the
 * contract's [C] form, so a CLI that drifted from it would publish what devices cannot apply.
 *
 * P4-22 (plans/P4-10.md risk 2): the CLI's chunker reproduces the corpus's chunk indexes
 * (`chunks/v1.pkc`, `chunks/v2.pkc`) id for id and length for length. `clen` and the bundle
 * hashes depend on the zstd build (and the corpus bundles at 256 KiB), so they are not compared.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { FilesIndexDoc, PatchDoc } from "@polaris-key/protocol/packs";
import { parseChunkIndexBytes } from "@polaris-key/client-core/packs";
import {
  buildFilesDelta,
  chunkContainer,
  CHUNK_PARAMS,
  buildPayload,
  containerPayload,
  readPck,
  selfCheckPayload,
  zstdCli,
  type BuiltPayload,
  type Zstd,
} from "../src/index.js";
import { sha } from "./packFixtures.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const BLOBS = path.join(repoRoot, "conformance/corpus/v2/content/blobs");
const work = mkdtempSync(path.join(os.tmpdir(), "pkey-pack-corpus-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function blob(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(BLOBS, ...name.split("/"))));
}
function unzstd(frame: Uint8Array): Uint8Array {
  const i = path.join(work, `f${Math.random().toString(36).slice(2)}`);
  writeFileSync(i, frame);
  execFileSync("zstd", ["-d", "-q", "-f", i, "-o", `${i}.out`]);
  return new Uint8Array(readFileSync(`${i}.out`));
}
const doc = <T>(b: Uint8Array) =>
  JSON.parse(Buffer.from(b).toString("utf8")) as T;

/** v1 from its full blob; v2 by the file strategy over v2's index, its gaps and the file blobs. */
function corpusPayloads() {
  const v1 = unzstd(blob("payload/v1.full.zst"));
  const i1 = doc<FilesIndexDoc>(unzstd(blob("files/v1.files.zst")));
  const i2 = doc<FilesIndexDoc>(unzstd(blob("files/v2.files.zst")));
  const v1Files = new Map(
    i1.files.map((e) => [e.sha256, v1.subarray(e.offset!, e.offset! + e.size)]),
  );
  const gaps = unzstd(blob("files/v2.gaps.zst"));
  const parts: Uint8Array[] = [];
  let g = 0;
  let pos = 0;
  for (const e of i2.files) {
    parts.push(gaps.subarray(g, g + e.offset! - pos));
    g += e.offset! - pos;
    let data = v1Files.get(e.sha256);
    if (!data) {
      const stored = blob(`files/${e.blob.sha256}`);
      data = e.blob.codec === "zstd" ? unzstd(stored) : stored;
    }
    parts.push(data);
    pos = e.offset! + e.size;
  }
  parts.push(gaps.subarray(g));
  const v2 = new Uint8Array(Buffer.concat(parts));
  return { v1, v2, i1, i2 };
}

const shape = (o: object) => Object.keys(o).sort();

/** The CLI's zstd runs synchronously, so a whole build blocks the event loop (about 35 s on a CI
 *  runner). Yielding between phases lets vitest's worker-to-main RPC through; a single block near
 *  a minute fails the run with "Timeout calling onTaskUpdate" though every test passes. */
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** The real zstd CLI, remembering each frame it made by the input's hash. v2 shares most of its
 *  files with v1, so building both compresses each shared file once; every frame is still the
 *  CLI's own, from this run. */
function rememberingZstd(z: Zstd): Zstd {
  const frames = new Map<string, Uint8Array>();
  return {
    version: z.version,
    compressMany(inputs) {
      const keys = inputs.map((b) => sha(b));
      const todo = new Map<string, Uint8Array>();
      keys.forEach((k, i) => {
        if (!frames.has(k)) todo.set(k, inputs[i]!);
      });
      const made = z.compressMany([...todo.values()]);
      [...todo.keys()].forEach((k, i) => frames.set(k, made[i]!));
      return keys.map((k) => frames.get(k)!);
    },
    patchFrom: (base, target) => z.patchFrom(base, target),
    decodeMany: (frames) => z.decodeMany(frames),
    decodePatch: (frame, base) => z.decodePatch(frame, base),
  };
}

/** Each build test's own budget, kept at the 120 s the single two-payload test had, for half the
 *  work. A payload build is mostly `zstd -19` over its 5.3 MB `full` object and its files, in
 *  child processes: 2-3 s idle, at most 8 s measured with `--maxWorkers=2`, three runs at once,
 *  beside 16 CPU-bound processes on an 18-core machine (load average about 60). The vitest
 *  default (20 s) is within reach of a gate loaded harder than that. */
const BUILD_MS = 120_000;

describe("the CLI against the content corpus (P4-04)", () => {
  const z = rememberingZstd(zstdCli(work));
  const { v1, v2, i1, i2 } = corpusPayloads();
  /** Each payload is built and self-checked once, by whichever test needs it first, so no test
   *  depends on another having run (or finished) before it. */
  const builds = new Map<Uint8Array, Promise<BuiltPayload>>();
  const built = (bytes: Uint8Array): Promise<BuiltPayload> => {
    let b = builds.get(bytes);
    if (!b) {
      b = (async () => {
        await yieldToLoop();
        const out = await buildPayload(
          z,
          containerPayload(bytes, readPck(bytes)),
        );
        await yieldToLoop();
        await selfCheckPayload(z, out);
        return out;
      })();
      builds.set(bytes, b);
    }
    return b;
  };

  it("rebuilds the corpus's v2 payload, the payload v2's index names", () => {
    expect({ size: v2.byteLength, sha256: sha(v2) }).toEqual(i2.payload);
    expect({ size: v1.byteLength, sha256: sha(v1) }).toEqual(i1.payload);
  });

  // One payload a test (they were one test of about 5 s idle that timed out at 120 s on a loaded
  // gate).
  for (const [name, bytes, corpus] of [
    ["v1", v1, i1],
    ["v2", v2, i2],
  ] as const)
    it(
      `builds ${name}'s files index with the corpus's structure`,
      async () => {
        const b = await built(bytes);
        expect(shape(b.index)).toEqual(shape(corpus));
        expect([b.index.format, b.index.layout]).toEqual([
          corpus.format,
          corpus.layout,
        ]);
        expect(b.index.payload).toEqual(corpus.payload);
        expect(
          b.index.files.map((e) => [e.path, e.offset, e.size, e.sha256]),
        ).toEqual(
          corpus.files.map((e) => [e.path, e.offset, e.size, e.sha256]),
        );
        for (const [k, e] of b.index.files.entries()) {
          const c = corpus.files[k]!;
          expect(shape(e)).toEqual(shape(c));
          expect(shape(e.blob)).toEqual(shape(c.blob));
          expect(e.blob.codec).toBe(c.blob.codec);
        }
        expect(b.gaps!.ref.size).toBe(
          corpus.payload.size - corpus.files.reduce((a, e) => a + e.size, 0),
        );
      },
      BUILD_MS,
    );

  it(
    "builds the v1 → v2 files descriptor with the corpus's structure",
    async () => {
      const corpus = doc<PatchDoc>(unzstd(blob("patch/v1-v2.files.zst")));
      const [b1, b2] = await Promise.all([built(v1), built(v2)]);
      const fd = buildFilesDelta(
        z,
        { sha256: b1.payload.sha256, files: b1.files },
        b2,
      );
      if ("skipped" in fd) throw new Error(fd.skipped);
      expect(shape(fd.doc)).toEqual(shape(corpus));
      const head = (d: PatchDoc) => [d.format, d.scope, d.method, d.from, d.to];
      expect(head(fd.doc)).toEqual(head(corpus));
      const entries = (d: PatchDoc) =>
        d.entries.map((e) => [e.path, e.op, e.from ?? null, e.to, e.size]);
      expect(entries(fd.doc)).toEqual(entries(corpus));
      for (const [k, e] of fd.doc.entries.entries())
        expect(shape(e)).toEqual(shape(corpus.entries[k]!));
    },
    BUILD_MS,
  );
});

describe("the CLI chunker against the content corpus (P4-22)", () => {
  const { v1, v2 } = corpusPayloads();

  it("reproduces (id, len) of chunks/v1.pkc and chunks/v2.pkc", () => {
    for (const [bytes, name] of [
      [v1, "chunks/v1.pkc"],
      [v2, "chunks/v2.pkc"],
    ] as const) {
      const corpus = parseChunkIndexBytes(blob(name), {
        size: bytes.byteLength,
        sha256: sha(bytes),
      });
      if (!corpus.ok) throw new Error(`${name}: ${corpus.error}`);
      expect(corpus.index.fileAware).toBe(CHUNK_PARAMS.fileAware);
      const p = containerPayload(bytes, readPck(bytes));
      const chunks = chunkContainer(
        (p as { bytes: Uint8Array }).bytes,
        p.files,
      );
      expect(chunks.map((c) => [c.id, c.len])).toEqual(
        corpus.index.records.map(([id, len]) => [id, len]),
      );
    }
  });
});
