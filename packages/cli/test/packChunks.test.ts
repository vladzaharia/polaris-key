/**
 * P4-22 — chunk indexes and shared chunk bundles in `pkey release publish` (plans/P4-10.md §2.4,
 * §9's P4-22 block): the file-aware chunker and its padding rule, raw storage and frame content
 * sizes, determinism, the chain along `--out`/`--bases` with the stage round's `present`, the
 * gate, and every reason a variant ships without `chunks`. The publishes run against
 * `packFixtures.ts`'s fake Polaris Key with a lowered size threshold (`chunkMinPayloadBytes`), so
 * a sub-megabyte PCK is chunked exactly as a 4 MiB one would be.
 */

import { readdir, readFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseChunkIndex } from "@polaris-key/client-core/packs";
import { decode } from "@polaris-key/zstd-wasm";
import type { PackRecordDoc } from "@polaris-key/protocol/packs";
import {
  buildChunks,
  chunkContainer,
  CHUNK_PARAMS,
  containerPayload,
  containerSegments,
  frameContentSize,
  priorLocations,
  publishPack,
  readPck,
  zstdCli,
  type PackPublishOptions,
} from "../src/index.js";
import { capture, cleanup, instant } from "./publishFixture.js";
import {
  actionsEnv,
  BASE,
  kaykitV1,
  levelJson,
  noiseBytes,
  packRepo,
  packServer,
  sha,
  SLUG,
  testReleaseKey,
  writeFiles,
  writeTestPck,
  type PackRepoOptions,
} from "./packFixtures.js";

afterEach(cleanup);
const work = mkdtempSync(path.join(os.tmpdir(), "pkey-chunks-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const key = testReleaseKey();
const PCK = "default/diceroll.core3d.pck";

/** The kaykit pack plus three incompressible 160 KB files and a compressible 300 KB one. */
function chunky(edit = 0): [string, Uint8Array][] {
  const big: [string, Uint8Array][] = [0, 1, 2].map((i) => [
    `assets/kaykit/data/big_${i}.bin`,
    noiseBytes(160_000, 40 + i, i === 1 ? edit : 0),
  ]);
  const rows: Uint8Array[] = [];
  for (let n = 0; n < 120; n++) rows.push(levelJson(n));
  return [
    ...kaykitV1(),
    ...big,
    ["assets/kaykit/data/huge.json", new Uint8Array(Buffer.concat(rows))],
  ];
}

async function setup(o: PackRepoOptions = {}, edit = 0) {
  const cwd = await packRepo(key, { [PCK]: writeTestPck(chunky(edit)) }, o);
  return { cwd, server: packServer() };
}

function opts(
  cwd: string,
  server: ReturnType<typeof packServer>,
  over: Partial<PackPublishOptions> = {},
) {
  const io = capture();
  return {
    io,
    o: {
      cwd,
      product: SLUG,
      deliverable: "diceroll.core3d",
      version: "1.0.0",
      dir: "dist",
      out: "cache",
      bases: "cache",
      baseUrl: BASE,
      env: actionsEnv(),
      stdout: io.stdout,
      stderr: io.stderr,
      fetchImpl: server.fetchImpl,
      sleep: instant,
      releaseKeyPem: key.pem,
      now: 1_759_300_000,
      chunkMinPayloadBytes: 0,
      ...over,
    } satisfies PackPublishOptions,
  };
}

const payloadOf = (jws: string) =>
  JSON.parse(
    Buffer.from(jws.split(".")[1]!, "base64url").toString(),
  ) as PackRecordDoc;

/** The SHA-256s a publish PUT (staged), from the R2 PUTs' bytes. */
const putShas = (server: ReturnType<typeof packServer>) =>
  new Set(server.puts().map((c) => sha(c.bytes!)));

/** The chunk index the publish staged for its only variant, parsed. */
async function stagedIndex(
  server: ReturnType<typeof packServer>,
  record: PackRecordDoc,
) {
  const v = record.variants[0]!;
  const stored = [...server.r2.values()].find(
    (b) => sha(b) === v.chunks!.sha256,
  );
  expect(stored, "the chunk index was uploaded").toBeDefined();
  const parsed = await parseChunkIndex(stored!, v.chunks!, v.payload, {
    decode: (f, s) => decode(f, s),
  });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.index;
}

// ── The chunker ────────────────────────────────────────────────────────────

describe("the file-aware chunker (plans/P4-10.md §2.4)", () => {
  const bytes = writeTestPck(chunky());
  const p = containerPayload(bytes, readPck(bytes));
  const files = p.files;

  it("no chunk straddles an entry", () => {
    const chunks = chunkContainer(bytes, files);
    expect(chunks.length).toBeGreaterThan(files.length);
    for (const c of chunks) {
      const touched = files.filter(
        (f) =>
          f.size > 0 &&
          f.offset! < c.offset + c.len &&
          c.offset < f.offset! + f.size,
      );
      expect(touched.length, `chunk at ${c.offset}`).toBeLessThanOrEqual(1);
    }
  });

  it("a padding gap under 64 bytes joins the entry before it; a longer gap stays its own", () => {
    const segs = containerSegments(
      [
        { offset: 100, size: 50 },
        { offset: 160, size: 40 }, // a 10-byte gap after the first entry
        { offset: 300, size: 10 }, // a 100-byte gap after the second
      ],
      400,
      CHUNK_PARAMS.padMerge,
    );
    expect(segs).toEqual([
      [0, 100], // the header
      [100, 60], // entry + its 10-byte padding
      [160, 40],
      [200, 100], // a long gap: a segment of its own
      [300, 10],
      [310, 90], // the tail (directory)
    ]);
    // Exactly 63 bytes join; 64 do not.
    expect(
      containerSegments(
        [
          { offset: 0, size: 10 },
          { offset: 73, size: 10 },
        ],
        83,
        64,
      ),
    ).toEqual([
      [0, 73],
      [73, 10],
    ]);
    expect(
      containerSegments(
        [
          { offset: 0, size: 10 },
          { offset: 74, size: 10 },
        ],
        84,
        64,
      ),
    ).toEqual([
      [0, 10],
      [10, 64],
      [74, 10],
    ]);
  });

  it("stores an incompressible chunk raw and every frame with a content size equal to len; the same input gives the same index", async () => {
    const z = zstdCli(work);
    const chunks = chunkContainer(bytes, files);
    const payload = { bytes, size: bytes.byteLength, sha256: sha(bytes) };
    const a = await buildChunks(z, payload, chunks, null, new Map());
    const b = await buildChunks(z, payload, chunks, null, new Map());
    if ("omitted" in a || "omitted" in b) throw new Error("omitted");
    expect(Buffer.compare(a.index.stored, b.index.stored)).toBe(0);
    expect(a.ref.params).toEqual({ ...CHUNK_PARAMS, bundleLayout: "fresh" });
    const raw = a.doc.records.filter(([, len, clen]) => clen === len);
    const framed = a.doc.records.filter(([, len, clen]) => clen < len);
    expect(raw.length).toBeGreaterThan(0);
    expect(framed.length).toBeGreaterThan(0);
    for (const [id, len, clen, bi, offset] of a.doc.records) {
      const bundle = a.bundles.get(a.doc.bundles[bi]![0])!;
      const storedChunk = bundle.subarray(offset, offset + clen);
      if (clen < len) {
        expect(frameContentSize(storedChunk)).toBe(len);
        expect(sha(decode(storedChunk, len))).toBe(id);
      } else expect(sha(storedChunk)).toBe(id);
    }
    // One bundle under the 4 MiB target holds them all, its size the table's.
    expect(a.doc.bundles).toEqual([
      [[...a.bundles.keys()][0], [...a.bundles.values()][0]!.byteLength],
    ]);
  }, 60_000);

  it("reuses only the locations of bundles reported present", async () => {
    const z = zstdCli(work);
    const chunks = chunkContainer(bytes, files);
    const payload = { bytes, size: bytes.byteLength, sha256: sha(bytes) };
    const first = await buildChunks(z, payload, chunks, null, new Map());
    if ("omitted" in first) throw new Error("omitted");
    const base = { version: "1.0.0", index: first.doc };
    const all = priorLocations(first.doc, () => true);
    const none = priorLocations(first.doc, () => false);
    expect(all.size).toBe(new Set(chunks.map((c) => c.id)).size);
    expect(none.size).toBe(0);
    const again = await buildChunks(z, payload, chunks, base, all);
    if ("omitted" in again) throw new Error("omitted");
    expect(again.bundles.size).toBe(0);
    expect(again.ref.params?.bundleLayout).toBe("shared");
    expect(again.doc).toEqual(first.doc);
  }, 60_000);
});

// ── The publish ────────────────────────────────────────────────────────────

describe("chunk indexes in pkey release publish (P4-22)", () => {
  it("signs chunks into the variant, stages the index and its bundles, and keeps the index for --bases", async () => {
    const { cwd, server } = await setup();
    const { io, o } = opts(cwd, server);
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    const record = payloadOf(res.recordJws!);
    const v = record.variants[0]!;
    expect(v.chunks).toMatchObject({
      format: "pkey-chunks/1",
      params: { ...CHUNK_PARAMS, bundleLayout: "fresh" },
    });
    const index = await stagedIndex(server, record);
    const puts = putShas(server);
    for (const [bundle] of index.bundles) expect(puts.has(bundle)).toBe(true);
    expect(res.variants[0]!.chunks).toMatchObject({
      newBundles: index.bundles.length,
      reusedBytes: 0,
      base: null,
    });
    expect(io.out()).toMatch(
      /chunks: \d+ \(\d+ distinct\), index \d+ B; 1 new bundle/,
    );
    const cached = await readdir(
      path.join(cwd, "cache/diceroll.core3d/1.0.0/default"),
    );
    expect(cached).toContain(`chunks.${v.chunks!.sha256}`);
  }, 60_000);

  it("a second publish of the same payload uploads no bundle (and a pack without deltas still reads --bases)", async () => {
    const { cwd, server } = await setup({ deltaBases: 0 });
    await publishPack(opts(cwd, server).o);
    const before = server.puts().length;
    const { io, o } = opts(cwd, server, { version: "1.0.1" });
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    expect(server.puts().length).toBe(before);
    expect(res.variants[0]!.chunks).toMatchObject({
      newBundles: 0,
      base: "1.0.0",
    });
    expect(res.variants[0]!.chunks!.reusedBytes).toBeGreaterThan(0);
    const v1 = payloadOf(server.stored.get("diceroll.core3d@1.0.0")!.jws!);
    const v2 = payloadOf(res.recordJws!);
    expect(v2.variants[0]!.chunks!.sha256).toBe(v1.variants[0]!.chunks!.sha256);
    expect(v2.variants[0]!.chunks!.params!.bundleLayout).toBe("shared");
  }, 60_000);

  it("an edited payload reuses the unchanged chunks and uploads one new bundle of the changed ones", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    const v1 = payloadOf(server.stored.get("diceroll.core3d@1.0.0")!.jws!);
    const i1 = await stagedIndex(server, v1);
    await writeFiles(path.join(cwd, "dist"), {
      [PCK]: writeTestPck(chunky(5)),
    });
    const { io, o } = opts(cwd, server, { version: "1.0.1" });
    const res = await publishPack(o);
    // Only the re-import noise report (the edit is 5 bytes at equal length).
    expect(io.err()).not.toMatch(/chunk/);
    const v2 = payloadOf(res.recordJws!);
    const i2 = await stagedIndex(server, v2);
    // The old bundle is listed first (records reference it first), the new one after.
    expect(i2.bundles[0]).toEqual(i1.bundles[0]);
    expect(i2.bundles).toHaveLength(2);
    const changed = i2.records.filter(([, , , bi]) => bi === 1);
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.length).toBeLessThan(i2.records.length / 2);
    expect(res.variants[0]!.chunks).toMatchObject({
      newBundles: 1,
      reusedBundles: 1,
      base: "1.0.0",
    });
  }, 60_000);

  it("an absent reused bundle is repacked fresh, with a warning", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    const v1 = payloadOf(server.stored.get("diceroll.core3d@1.0.0")!.jws!);
    const i1 = await stagedIndex(server, v1);
    server.referenced.delete(i1.bundles[0]![0]);
    const { io, o } = opts(cwd, server, { version: "1.0.1" });
    const res = await publishPack(o);
    expect(io.err()).toContain(
      "warning: default: 1 chunk bundle of the chain from 1.0.0 is not stored; their chunks are packed fresh.",
    );
    const i2 = await stagedIndex(server, payloadOf(res.recordJws!));
    // Packed fresh from the payload: the same chunks in the same order, so the same bundle,
    // uploaded again.
    expect(i2.bundles).toEqual(i1.bundles);
    expect(res.uploaded).toContain(`blobs/sha256/${i1.bundles[0]![0]}`);
    expect(
      payloadOf(res.recordJws!).variants[0]!.chunks!.params!.bundleLayout,
    ).toBe("fresh");
  }, 60_000);

  it("a gate change starts a fresh chain, and a gated pack writes gated/ keys", async () => {
    const { cwd, server } = await setup({ deltaBases: 0 });
    await publishPack(opts(cwd, server).o);
    server.gate = "hd";
    const { io, o } = opts(cwd, server, { version: "1.0.1" });
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    const record = payloadOf(res.recordJws!);
    expect(record.entitlement).toBe("hd");
    expect(record.variants[0]!.chunks!.params!.bundleLayout).toBe("fresh");
    expect(res.variants[0]!.chunks!.base).toBeNull();
    const index = await stagedIndex(server, record);
    for (const [bundle] of index.bundles)
      expect(res.uploaded.concat(res.skipped)).toContain(
        `gated/blobs/sha256/${bundle}`,
      );
    // Every ticket of the gated publish asked for gated objects.
    const tickets = server
      .to("/release/publish/uploads")
      .map((c) => c.body as { objects?: { gated: boolean }[] })
      .filter((b) => b.objects);
    expect(tickets.at(-1)!.objects!.every((x) => x.gated)).toBe(true);
  }, 60_000);

  it("no chunks below 4 MiB, without chunk in strategies, or without release.chunks", async () => {
    // Below the (default) 4 MiB threshold: no index, no warning.
    {
      const { cwd, server } = await setup();
      const { io, o } = opts(cwd, server, { chunkMinPayloadBytes: undefined });
      const res = await publishPack(o);
      expect(io.err()).toBe("");
      expect(payloadOf(res.recordJws!).variants[0]!.chunks).toBeUndefined();
      expect(res.variants[0]!.chunks).toBeUndefined();
    }
    // An explicit strategy list without chunk opts out.
    {
      const { cwd, server } = await setup({ strategies: "[delta, file]" });
      const { io, o } = opts(cwd, server);
      const res = await publishPack(o);
      expect(io.err()).toBe("");
      expect(payloadOf(res.recordJws!).variants[0]!.chunks).toBeUndefined();
    }
    // A Worker that does not advertise release.chunks: omitted, with a warning.
    {
      const { cwd, server } = await setup();
      server.chunks = false;
      const { io, o } = opts(cwd, server);
      const res = await publishPack(o);
      expect(io.err()).toContain("does not advertise release.chunks");
      expect(payloadOf(res.recordJws!).variants[0]!.chunks).toBeUndefined();
      expect(res.variants[0]!.chunksOmitted).toMatch(/release\.chunks/);
    }
  }, 60_000);

  it("an index over MAX_PUBLISHED_INDEX_BYTES is omitted with a warning, and the publish goes on", async () => {
    const { cwd, server } = await setup();
    const { io, o } = opts(cwd, server, { maxChunkIndexBytes: 200 });
    const res = await publishPack(o);
    expect(io.err()).toMatch(
      /warning: default: no chunk index: its chunk index would be at least \d+ bytes \(\d+ chunks\); Polaris Key reads at most 200 per index\./,
    );
    expect(payloadOf(res.recordJws!).variants[0]!.chunks).toBeUndefined();
    expect(res.server).toMatchObject({ outcome: "created" });
  }, 60_000);

  it("a dry run prints the chunks, the new bundles and the reused bytes", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    await writeFiles(path.join(cwd, "dist"), {
      [PCK]: writeTestPck(chunky(5)),
    });
    const { io, o } = opts(cwd, server, { version: "1.0.1", dryRun: true });
    const res = await publishPack(o);
    expect(res.dryRun).toBe(true);
    expect(io.out()).toMatch(
      /chunks: \d+ \(\d+ distinct\), index \d+ B; 1 new bundle \(\d+ B\); reused \d+ B in 1 bundle from 1\.0\.0/,
    );
    expect(io.out()).toContain('"chunks"');
  }, 60_000);

  it("a missing cached index falls back to the next older proven release", async () => {
    const { cwd, server } = await setup({ deltaBases: 0 });
    await publishPack(opts(cwd, server).o);
    await publishPack(opts(cwd, server, { version: "1.0.1" }).o);
    const dir = path.join(cwd, "cache/diceroll.core3d/1.0.1/default");
    const name = (await readdir(dir)).find((n) => n.startsWith("chunks."))!;
    rmSync(path.join(dir, name));
    const before = server.puts().length;
    const { io, o } = opts(cwd, server, { version: "1.0.2" });
    const res = await publishPack(o);
    expect(io.err()).toContain("chunk chain diceroll.core3d 1.0.1 (default)");
    expect(res.variants[0]!.chunks).toMatchObject({
      base: "1.0.0",
      newBundles: 0,
    });
    expect(server.puts().length).toBe(before);
  }, 60_000);

  it("a second pack with the same payload uploads its own bundles: present means THIS pack's upload (a rename, or two packs sharing a variant)", async () => {
    const twin = `    diceroll.core3d2:
      kind: pack
      type: godot.pck
      handler:
        prefixes: ["res://assets/kaykit/"]
      requires:
        engine: godot-4.7
`;
    const { cwd, server } = await setup({ extraPacks: twin, deltaBases: 0 });
    const first = await publishPack(opts(cwd, server).o);
    const i1 = await stagedIndex(server, payloadOf(first.recordJws!));
    const { io, o } = opts(cwd, server, { deliverable: "diceroll.core3d2" });
    const res = await publishPack(o);
    expect(io.err()).toBe("");
    // Every ticket of the second publish named its pack.
    const bodies = server
      .to("/release/publish/uploads")
      .map((c) => c.body as { objects?: unknown; deliverable?: string })
      .filter((b) => b.objects);
    expect(bodies.at(-1)!.deliverable).toBe("diceroll.core3d2");
    // The same bytes, uploaded and staged again for the second pack.
    const i2 = await stagedIndex(server, payloadOf(res.recordJws!));
    expect(i2.bundles).toEqual(i1.bundles);
    expect(res.uploaded).toContain(`blobs/sha256/${i1.bundles[0]![0]}`);
    expect(
      server.packUploads.has(`diceroll.core3d2:${i1.bundles[0]![0]}`),
    ).toBe(true);
  }, 60_000);

  it("a cached index that is missing costs reuse, not the publish", async () => {
    const { cwd, server } = await setup();
    await publishPack(opts(cwd, server).o);
    const dir = path.join(cwd, "cache/diceroll.core3d/1.0.0/default");
    const name = (await readdir(dir)).find((n) => n.startsWith("chunks."))!;
    rmSync(path.join(dir, name));
    const { io, o } = opts(cwd, server, { version: "1.0.1" });
    const res = await publishPack(o);
    expect(io.err()).toContain(
      `chunk chain diceroll.core3d 1.0.0 (default): the cached index ${name} is missing; an older cached release is tried`,
    );
    expect(res.variants[0]!.chunks!.base).toBeNull();
    expect(
      await readFile(
        path.join(cwd, "cache/diceroll.core3d/1.0.1/default", name),
      ),
    ).toBeDefined();
  }, 60_000);
});
