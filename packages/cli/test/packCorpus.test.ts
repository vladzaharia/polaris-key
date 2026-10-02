/**
 * P4-03 against P4-04's content corpus: for the corpus's v1 and v2 payloads, the CLI's files
 * index and `files` descriptor have the same structure as the committed ones
 * (`conformance/corpus/v2/content/blobs/`), read through the zstd CLI. The corpus is the
 * contract's [C] form, so a CLI that drifted from it would publish what devices cannot apply.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { FilesIndexDoc, PatchDoc } from "@polaris-key/protocol/packs";
import {
  buildFilesDelta,
  buildPayload,
  containerPayload,
  readPck,
  selfCheckPayload,
  zstdCli,
  type BuiltPayload,
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

describe("the CLI against the content corpus (P4-04)", () => {
  const z = zstdCli(work);
  const { v1, v2, i1, i2 } = corpusPayloads();
  const built: BuiltPayload[] = [];

  it("rebuilds the corpus's v2 payload, the payload v2's index names", () => {
    expect({ size: v2.byteLength, sha256: sha(v2) }).toEqual(i2.payload);
    expect({ size: v1.byteLength, sha256: sha(v1) }).toEqual(i1.payload);
  });

  it("builds files indexes with the corpus's structure for v1 and v2", async () => {
    for (const [bytes, corpus] of [
      [v1, i1],
      [v2, i2],
    ] as const) {
      const b = await buildPayload(z, containerPayload(bytes, readPck(bytes)));
      await selfCheckPayload(z, b);
      built.push(b);
      expect(shape(b.index)).toEqual(shape(corpus));
      expect([b.index.format, b.index.layout]).toEqual([
        corpus.format,
        corpus.layout,
      ]);
      expect(b.index.payload).toEqual(corpus.payload);
      expect(
        b.index.files.map((e) => [e.path, e.offset, e.size, e.sha256]),
      ).toEqual(corpus.files.map((e) => [e.path, e.offset, e.size, e.sha256]));
      for (const [k, e] of b.index.files.entries()) {
        const c = corpus.files[k]!;
        expect(shape(e)).toEqual(shape(c));
        expect(shape(e.blob)).toEqual(shape(c.blob));
        expect(e.blob.codec).toBe(c.blob.codec);
      }
      expect(b.gaps!.ref.size).toBe(
        corpus.payload.size - corpus.files.reduce((a, e) => a + e.size, 0),
      );
    }
  }, 120_000);

  it("builds the v1 → v2 files descriptor with the corpus's structure", async () => {
    const corpus = doc<PatchDoc>(unzstd(blob("patch/v1-v2.files.zst")));
    const [b1, b2] = built as [BuiltPayload, BuiltPayload];
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
  }, 120_000);
});
